/* =========================================================
   Aletheia · Liquid Glass 模块（从 Aletheia.html 原样拆出，可单独使用）
   包含：GlassMotion（光斑跟随）· LiquidGlass v5（WebGL/SDF 折射引擎）· GlassLens（弹性拖拽 + 透镜）
   用法：
     <link rel="stylesheet" href="liquid-glass.css">
     <script src="liquid-glass.js"></script>
     给想要玻璃效果的元素加 data-glass 属性，然后：
     GlassMotion.init(); LiquidGlass.init(); GlassLens.init();
     浓度滑块：applyGlassIntensity(0~100)
   调试：?lg=off 关闭引擎；?lgr=0 关 SVG 折射；?lgtier=low|mid|high|ultra
========================================================= */
/* ---- 宿主依赖的最小垫片：在 Aletheia 里这些由主程序提供 ---- */
var $=window.$||function(s,r){return (r||document).querySelector(s);};
var clamp=window.clamp||function(v,a,b){return Math.max(a,Math.min(b,v));};
var Store=window.Store||{getItem:function(k){try{return localStorage.getItem(k);}catch(e){return null;}},setItem:function(k,v){try{localStorage.setItem(k,v);}catch(e){}}};

/* =========================================================
   ██ GlassMotion ██
========================================================= */
const GlassMotion=(()=>{
  /* 原来这里有四个能把手机烤热的点，逐个改掉：
     ① idle 那圈 rAF 无条件 60fps 跑到天荒地老，每帧写两个自定义属性 = 每帧让 dock 重绘一遍；
     ② 每帧一次 $('#dock')，即一次 document.querySelector；
     ③ pointermove 里每次 getBoundingClientRect —— 强制同步布局，触屏一秒几十次；
     ④ deviceorientation 在 iOS 上按 60Hz 回调，完全没节流，同样每次直接写样式。
     现在：元素和位置都缓存、指针与陀螺仪统一压到一帧一次、
     值没肉眼可见变化就不写（不写就不重绘）、呼吸动画限到约 20fps、切后台整圈停掉。 */
  let raf=0,idleRaf=0,lastPtr=-9999,dockEl=null,dockRect=null;
  let pending=null,lastA=-999,lastB=-999,lastIdle=0;
  const dock=()=>{if(!dockEl||!dockEl.isConnected){dockEl=$('#dock');dockRect=null;}return dockEl;};
  const rectOf=el=>{
    /* dock 的位置只在窗口尺寸/朝向变化时才会动，量一次缓存着就够 */
    if(el===dockEl){if(!dockRect)dockRect=el.getBoundingClientRect();return dockRect;}
    return el.getBoundingClientRect();
  };
  function write(el,mx,my){
    const a=Math.max(-20,Math.min(120,mx)),b=Math.max(-20,Math.min(120,my));
    if(el===dockEl){
      if(Math.abs(a-lastA)<0.5&&Math.abs(b-lastB)<0.5)return;   /* 差半个百分点看不出来，白重绘一帧不便宜 */
      lastA=a;lastB=b;
    }
    el.style.setProperty('--mx',a.toFixed(1)+'%');
    el.style.setProperty('--my',b.toFixed(1)+'%');
  }
  function setLocal(el,cx,cy){
    const r=rectOf(el);if(!r||!r.width||!r.height)return;
    write(el,((cx-r.left)/r.width)*100,((cy-r.top)/r.height)*100);
  }
  function flush(){
    raf=0;const p=pending;pending=null;if(!p)return;
    if(p.t==='ptr'){
      if(p.g)setLocal(p.g,p.x,p.y);
      const d=dock();if(d&&d!==p.g)setLocal(d,p.x,p.y);
    }else{
      const d=dock();if(d)write(d,50+p.gx*42,26+p.by*30);
    }
  }
  const queue=p=>{pending=p;lastPtr=performance.now();if(!raf)raf=requestAnimationFrame(flush);};
  function onPointer(e){queue({t:'ptr',g:e.target.closest?e.target.closest('[data-glass]'):null,x:e.clientX,y:e.clientY});}
  function onTilt(e){
    if(e.gamma==null&&e.beta==null)return;
    queue({t:'tilt',gx:Math.max(-1,Math.min(1,(e.gamma||0)/35)),by:Math.max(-1,Math.min(1,((e.beta||0)-45)/35))});
  }
  function idle(now){
    idleRaf=requestAnimationFrame(idle);
    if(now-lastIdle<48)return;lastIdle=now;      /* 呼吸周期 2.6 秒，一秒 60 帧纯属浪费 */
    if(performance.now()-lastPtr<1500)return;
    const d=dock();if(!d)return;
    const t=now/2600;write(d,50+Math.sin(t)*26,24+Math.cos(t*0.82)*12);
  }
  function init(){if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    document.addEventListener('pointermove',onPointer,{passive:true});
    if(window.DeviceOrientationEvent)window.addEventListener('deviceorientation',onTilt,{passive:true});
    const drop=()=>{dockRect=null;};
    addEventListener('resize',drop,{passive:true});
    addEventListener('orientationchange',drop,{passive:true});
    document.addEventListener('visibilitychange',()=>{
      if(document.visibilityState==='hidden'){if(idleRaf){cancelAnimationFrame(idleRaf);idleRaf=0;}}
      else if(!idleRaf){lastIdle=0;dockRect=null;idleRaf=requestAnimationFrame(idle);}
    });
    idleRaf=requestAnimationFrame(idle);}
  return {init};
})();

/* =========================================================
   ██ LiquidGlass v5 ██
   渲染
   · SDF 描述形状（圆角矩形 / 每角独立半径 / 药丸 / 圆），smin 平滑并集
   · 法线来自距离场梯度：只有底座时用解析梯度，有液滴并入时才用中心差分
   · 折射 Snell、三通道色散、三瓣高光、环境反射、焦散、边缘微虹彩
   两条渲染路径
   A) 实验室预览：自带背景纹理，WebGL 全量折射/色散（所有浏览器）
   B) 真实界面：WebGL 只出光照层；Chromium 额外用同一套 SDF 生成位移图，
      走 backdrop-filter:url() 真折射。Safari / Firefox 没有 SVG 折射，
      改用"透镜暗示"环（边缘内侧一圈亮带 + 一圈暗带）补出体积感。
   架构（v5 重构）
   · PROFILES：所有"按档位分支"只读这一张表，不再散落三元式
   · 着色器按质量档编译（LG_Q 0/1/2），低端机跑精简版而不是关掉
   · 深处像素走快路径（只算镜面+光斑），idle 时整块面积几乎不付法线的钱
   · Governor：交互时实测帧间隔，持续掉帧自动降一档并记住 7 天；不升档，不抖动
   · 低档不再整体关闭：dpr/帧率/折射/光照层逐项降级，玻璃始终在
   调试开关：?lg=off 关整个引擎；?lgr=0 只关 SVG 折射；?lgtier=low|mid|high|ultra
             强制档位（默认同时关闭 Governor，加 &lggov=1 保留）
========================================================= */
const LiquidGlass=(()=>{
  'use strict';
  const MAXS=4;
  const LS_CAP='dl.lgq';

  /* ---------- 环境 ---------- */
  const ua=navigator.userAgent||'';
  const isIOS=/iPad|iPhone|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  const isChromium=!isIOS&&/(Chrome|Chromium|Edg)\/\d/.test(ua);
  const qs=(()=>{try{return new URLSearchParams(location.search);}catch(_){return new URLSearchParams('');}})();
  const root=document.documentElement;
  const clamp=(x,a,b)=>x<a?a:x>b?b:x;
  const reduceMotion=()=>{try{return document.body&&document.body.getAttribute('data-motion')==='reduce';}catch(_){return false;}};

  /* ---------- 档位表 ----------
     dprS/dprB  小元素(输入栏、按钮)与大元素(抽屉、弹窗)的像素密度上限
     q          着色器质量 0/1/2      refract  是否启用 SVG 位移折射(仅 Chromium)
     drift      光源缓慢漂移          fps      重绘帧率上限，0=不限
     bigFollow  大元素是否跟手指光    blur     模糊半径倍率(乘进 --glass-b)
     disp       色散强度              shine    高光锐度 */
  const TIERS=['low','mid','high','ultra'];
  const PROF={
    low:  {dprS:1.5,dprB:1,   q:0,refract:false,drift:false,fps:30,bigFollow:false,blur:.55,disp:.04,shine:60},
    mid:  {dprS:1.5,dprB:1.25,q:1,refract:true, drift:false,fps:0, bigFollow:false,blur:.8, disp:.06,shine:70},
    high: {dprS:2,  dprB:1.5, q:2,refract:true, drift:true, fps:0, bigFollow:true, blur:1,  disp:.10,shine:70},
    ultra:{dprS:2.5,dprB:1.5, q:2,refract:true, drift:true, fps:0, bigFollow:true, blur:1,  disp:.13,shine:90}
  };
  /* iPhone 的 GPU 远强于同分数的安卓中端：小元素要 2x 才不糊边，光源也允许漂 */
  if(isIOS){PROF.low.dprS=2;PROF.mid.dprS=2;PROF.mid.drift=true;}

  let tier='mid',enabled=false,inited=false,refractOK=false,refractCapable=false,still=false;
  let gl=null,glc=null,prog=null,progQ=-1,U={},dummyTex=null,glOK=false,lab=null;
  const reg=new Map();
  const I={o:1,b:1};                                   /* 玻璃浓度滑块映射出的 --glass-o / --glass-b */
  const L={x:0,y:0,rx:-999,ry:-999,on:false,h:.8,tx:0,ty:0};
  let rafId=0,lastT=0,lastPaint=0,boostUntil=0,driftTimer=0,uid=0,defs=null,curDt=.016;
  const prof=()=>PROF[tier];

  /* ---------- 硬件分级 ---------- */
  function probeGPU(){
    /* 返回 {none:无WebGL, sw:软件渲染, s:0~3} */
    const r={none:false,sw:false,s:1};
    try{
      const c=document.createElement('canvas');
      const g=c.getContext('webgl')||c.getContext('experimental-webgl');
      if(!g){r.none=true;return r;}
      const dbg=g.getExtension('WEBGL_debug_renderer_info');
      const ren=dbg?String(g.getParameter(dbg.UNMASKED_RENDERER_WEBGL)||''):'';
      if(/Apple|Adreno [6-9]|Mali-G[7-9]|AMD|NVIDIA|GeForce|Radeon|Intel.*(Iris|Arc|Xe)/i.test(ren))r.s=2;
      if(/Apple M|Apple GPU.*(Pro|Max|Ultra)|RTX|RX [67]|Adreno [7-9]/i.test(ren))r.s=3;
      if(/SwiftShader|llvmpipe|Software/i.test(ren)){r.s=0;r.sw=true;}
      /* 探针上下文用完立刻释放，iOS 对同时存活的 WebGL 上下文数量有限制 */
      const lose=g.getExtension('WEBGL_lose_context');if(lose)lose.loseContext();
    }catch(_){}
    return r;
  }
  function detectTier(gpu){
    const ft=qs.get('lgtier');if(TIERS.indexOf(ft)>=0)return {t:ft,forced:true};
    try{
      const cores=navigator.hardwareConcurrency||4,mem=navigator.deviceMemory||4;
      const dprN=Math.min(devicePixelRatio||1,3);
      const px=(screen.width||0)*(screen.height||0)*dprN;
      const isIPadPro=isIOS&&Math.min(screen.width,screen.height)>=1024;
      const isDesktop=!isIOS&&!/Android/i.test(ua)&&(matchMedia('(pointer:fine)').matches||cores>=8);
      let score=gpu.s;
      if(cores>=8)score+=2;else if(cores>=6)score+=1;
      if(mem>=8)score+=2;else if(mem>=4)score+=1;
      if(px>=2.5e6)score+=1;
      if(isDesktop)score+=2;
      if(isIPadPro)score+=3;
      let t=score>=8?'ultra':score>=5?'high':score>=3?'mid':'low';
      /* 减弱动态效果：降到低档（静态光、无漂移），玻璃仍在 */
      if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)t='low';
      /* 上次被 Governor 降过档：不超过那一档（7 天有效） */
      const cap=loadCap();
      if(cap&&TIERS.indexOf(cap)<TIERS.indexOf(t))t=cap;
      return {t,forced:false};
    }catch(_){return {t:'mid',forced:false};}
  }
  function loadCap(){try{const j=JSON.parse(Store.getItem(LS_CAP)||'null');if(j&&TIERS.indexOf(j.t)>=0&&Date.now()-j.at<7*864e5)return j.t;}catch(_){}return null;}
  function saveCap(t){try{Store.setItem(LS_CAP,JSON.stringify({t,at:Date.now()}));}catch(_){}}

  /* ---------- 着色器 ---------- */
  const VS='attribute vec2 aP;void main(){gl_Position=vec4(aP,0.,1.);}';
  const FS_BODY=`
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
#define MAXS ${MAXS}
uniform vec2 uRes;uniform vec2 uOrig;uniform float uDpr;uniform vec2 uSize;uniform vec4 uRad;uniform float uBaseOn;
uniform vec4 uS[MAXS];uniform float uNS;uniform float uK;
uniform float uBezel;uniform float uThick;uniform float uIor;uniform float uDisp;uniform float uCurv;
uniform vec2 uLight;uniform float uLightH;uniform float uShine;uniform float uGain;uniform float uPress;
uniform vec3 uFinger;uniform float uFingerR;uniform float uLens;
uniform float uMode;uniform sampler2D uBg;uniform float uBlur;uniform vec3 uTint;uniform float uTintA;

float hash21(vec2 v){return fract(sin(dot(v,vec2(12.9898,78.233)))*43758.5453);}
/* 圆角矩形 SDF，四角半径 (tl,tr,br,bl) */
float sdRBox(vec2 p,vec2 b,vec4 r){
  float rr=p.x<0.?(p.y<0.?r.x:r.w):(p.y<0.?r.y:r.z);
  vec2 q=abs(p)-b+rr;
  return min(max(q.x,q.y),0.)+length(max(q,0.))-rr;
}
/* 同一个 SDF 的解析梯度：省掉 4 次 field() 中心差分 */
vec2 gradRBox(vec2 p,vec2 b,vec4 r){
  float rr=p.x<0.?(p.y<0.?r.x:r.w):(p.y<0.?r.y:r.z);
  vec2 q=abs(p)-b+rr;
  vec2 s=vec2(p.x<0.?-1.:1.,p.y<0.?-1.:1.);
  if(q.x<=0.&&q.y<=0.)return q.x>q.y?vec2(s.x,0.):vec2(0.,s.y);
  vec2 m=max(q,0.);float l=length(m);
  return l>1e-5?s*m/l:vec2(0.);
}
/* 多项式平滑最小值：两个形状在 k 范围内熔合 */
float smin(float a,float b,float k){float h=max(k-abs(a-b),0.)/k;return min(a,b)-h*h*k*.25;}
float field(vec2 p){
  float d=1e4;
  if(uBaseOn>.5)d=sdRBox(p-uSize*.5,uSize*.5,uRad);
  for(int i=0;i<MAXS;i++){
    if(float(i)>=uNS)break;
    vec4 s=uS[i];
    float di=sdRBox(p-s.xy,s.zw,vec4(min(s.z,s.w)));
    d=(d>1e3)?di:smin(d,di,uK);
  }
  return d;
}
/* 实时法线：距离场梯度给出朝向，凸面轮廓 h(t)=(1-(1-t)^4)^(1/4) 的斜率给出倾角 */
vec3 surfN(vec2 p,float d,out vec2 g){
  vec2 gr;
  if(uNS<.5)gr=gradRBox(p-uSize*.5,uSize*.5,uRad);
  else gr=vec2(field(p+vec2(1.,0.))-field(p-vec2(1.,0.)),field(p+vec2(0.,1.))-field(p-vec2(0.,1.)))*.5;
  float gl=length(gr);g=gl>1e-3?gr/gl:vec2(0.);
  float u=1.-clamp(-d/uBezel,0.,1.);
  float u3=u*u*u;
  float s=uCurv*u3*pow(max(1.-u3*u,1e-3),-.75);
  s=min(s,6.)*step(d,0.);
  vec3 n=vec3(g*s,1.);
  if(uFinger.z>0.){
    vec2 fp=p-uFinger.xy;float hb=uFinger.z*exp(-dot(fp,fp)/(2.*uFingerR*uFingerR));
    n.xy+=fp/(uFingerR*uFingerR)*hb*.6;
  }
  return normalize(n);
}
vec2 refOff(vec3 n,float ior){
  vec3 r=refract(vec3(0.,0.,-1.),n,1./ior);
  return r.xy/max(-r.z,.2)*uThick;
}
vec3 bgAt(vec2 pc){return texture2D(uBg,pc/uSize).rgb;}
vec3 blurTap(vec2 pc,float r){
  vec3 s=bgAt(pc)*2.;
  s+=bgAt(pc+vec2(r,0.))+bgAt(pc-vec2(r,0.))+bgAt(pc+vec2(0.,r))+bgAt(pc-vec2(0.,r));
  float r2=r*.7071;
  s+=bgAt(pc+vec2(r2,r2))+bgAt(pc+vec2(-r2,r2))+bgAt(pc+vec2(r2,-r2))+bgAt(pc+vec2(-r2,-r2));
  return s/10.;
}
void lights(vec2 p,float d,float mask,vec3 n,vec2 g,out vec3 E,out float da){
  float q=max(-d,0.);
  vec3 Lv=normalize(vec3(uLight-p,uLightH));
  vec3 Hh=normalize(Lv+vec3(0.,0.,1.));
  float nh=max(dot(n,Hh),1e-4);
  float spec=pow(nh,uShine)*.32+pow(nh,uShine*.2)*.04;
#if LG_Q>=1
  spec+=pow(nh,uShine*4.)*.30;                       /* 极窄亮点，跟光源/手指走 */
#endif
  float sig=.5*max(uSize.x,uSize.y);
  vec2 dl=p-uLight;
  float glow=exp(-dot(dl,dl)/(.7*sig*sig))*.025;
  float gg=uGain*(1.+.08*uPress);
  /* 深处快路径：离边缘一个斜面宽度以外，边缘项都已衰减到 0 */
  if(q>uBezel+12.&&uFinger.z<=0.){
    E=min((vec3(1.,.985,.96)*spec+glow)*mask*gg,vec3(1.));da=0.;return;
  }
  vec2 c=(uBaseOn>.5)?uSize*.5:p;
  vec2 Ld=normalize(uLight-c+vec2(.001,.002));
  float dt=dot(g,Ld);
  float w=.95+uPress*.15;
#if LG_Q>=1
  float ce=uDisp*8.;                                 /* 边缘色散：R 贴最外沿，B 向内多走 ce 像素 */
  vec3 rim=exp(-max(vec3(q)-vec3(-ce,0.,ce),0.)/w);
#else
  vec3 rim=vec3(exp(-q/w));
#endif
#if LG_Q>=2
  float ang=atan(g.y,g.x+1e-5);                      /* 边缘微虹彩：色相随朝向变，很淡 */
  vec3 irid=.5+.5*cos(ang+vec3(0.,2.094,4.188));
  rim*=mix(vec3(1.),irid*1.25,.20);
#endif
  float key=pow(max(dt,0.),1.8)*.55;
  float fill=pow(max(-dt,0.),2.4)*.22;
  float F=pow(1.-n.z,3.);
  E=rim*(key+fill)+vec3(1.,.985,.96)*spec;
#if LG_Q>=1
  float sky=dot(normalize(n.xy+vec2(1e-4)),vec2(0.,-1.))*.5+.5;   /* 朝上的斜面映天光，朝下的映暗地面 */
  E+=mix(vec3(.30,.36,.48),vec3(.95,.98,1.),sky)*F*.20;
#else
  E+=vec3(.85,.92,1.)*F*.12;
#endif
#if LG_Q>=2
  E+=vec3(.80,.90,1.)*exp(-pow((q-uBezel*.42)/(uBezel*.24),2.))*pow(max(-dt,0.),1.4)*.15;   /* 背光侧焦散 */
#endif
  if(uLens>.5){                                       /* 无真折射时的透镜暗示：外亮内暗两圈 */
    E+=vec3(.9,.95,1.)*exp(-pow((q-uBezel*.20)/(uBezel*.13),2.))*(.035+.05*max(dt,0.));
  }
  E+=vec3(1.)*glow;
  E*=mask*gg;
#if LG_Q>=2
  E+=(hash21(gl_FragCoord.xy)-.5)/255.*mask;         /* 抖动：暗底渐变不出色带 */
#endif
  E=clamp(E,vec3(0.),vec3(1.));
  da=mask*(exp(-q/7.)*max(-dt,0.)*.10+exp(-q/2.)*.03);
#if LG_Q>=2
  da+=mask*exp(-q/(uBezel*.55))*max(-dt,0.)*.035;
#endif
  if(uLens>.5)da+=mask*exp(-pow((q-uBezel*.60)/(uBezel*.22),2.))*.045;
}
void main(){
  vec2 p=vec2(gl_FragCoord.x,uRes.y-gl_FragCoord.y)/uDpr-uOrig;
  float d=field(p);
  float mask=1.-smoothstep(-.75,.75,d);
  if(uMode<.5&&mask<=.002){gl_FragColor=vec4(0.);return;}
  vec2 g=vec2(0.);vec3 n=vec3(0.,0.,1.);
  if(!(uNS<.5&&uFinger.z<=0.&&d<-uBezel-1.))n=surfN(p,d,g);
  vec3 E;float da;
  lights(p,d,mask,n,g,E,da);
  if(uMode<.5){
    /* 膨出到元素外面的那部分没有 backdrop，补一层很淡的玻璃体，让融合出来的形状可见 */
    float dB=(uBaseOn>.5)?sdRBox(p-uSize*.5,uSize*.5,uRad):-1e3;
    E+=vec3(.86,.92,1.)*smoothstep(-.6,.6,dB)*mask*.32;
    float mx=max(max(E.r,E.g),E.b);
    float a=1.-(1.-mx)*(1.-da);
    gl_FragColor=vec4(E*(1.-da),a);
    return;
  }
  vec3 bg=bgAt(p);
  float ds=field(p-vec2(0.,8.));
  bg*=1.-.30*exp(-max(ds,0.)/10.)*(1.-mask);
#if LG_Q>=2
  float sp=field(p-vec2(0.,20.));                    /* 透过玻璃落在下面的焦散光晕，偏冷 */
  bg+=vec3(.50,.62,.85)*.045*exp(-max(sp,0.)/14.)*(1.-mask)*smoothstep(2.,14.,max(ds,0.));
#endif
  if(mask<.002){gl_FragColor=vec4(bg,1.);return;}
  vec3 col;
#if LG_Q>=1
  vec2 oG=refOff(n,uIor),oR=refOff(n,uIor-uDisp),oB=refOff(n,uIor+uDisp);
  col=vec3(blurTap(p+oR,uBlur).r,blurTap(p+oG,uBlur).g,blurTap(p+oB,uBlur).b);
#else
  col=blurTap(p+refOff(n,uIor),uBlur);               /* 低档：只折射一次，不分色 */
#endif
  float lum=dot(col,vec3(.299,.587,.114));
  col=mix(vec3(lum),col,1.3);
  col=mix(col,uTint,uTintA);
  col=col*(1.-da)+E;
  gl_FragColor=vec4(mix(bg,col,mask),1.);
}`;

  function compile(type,src){
    const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){try{console.warn('[LiquidGlass] shader',gl.getShaderInfoLog(s));}catch(_){}return null;}
    return s;
  }
  function link(q){
    const vs=compile(gl.VERTEX_SHADER,VS),fs=compile(gl.FRAGMENT_SHADER,'#define LG_Q '+q+'\n'+FS_BODY);
    if(!vs||!fs)return null;
    const pr=gl.createProgram();gl.attachShader(pr,vs);gl.attachShader(pr,fs);
    gl.bindAttribLocation(pr,0,'aP');gl.linkProgram(pr);
    return gl.getProgramParameter(pr,gl.LINK_STATUS)?pr:null;
  }
  /* 按质量档编译；失败就逐级回退，最低一档也失败才放弃 */
  function buildProgram(q){
    let pr=null;
    for(let k=q;k>=0&&!pr;k--){pr=link(k);if(pr)progQ=k;}
    if(!pr)return false;
    if(prog)gl.deleteProgram(prog);
    prog=pr;gl.useProgram(prog);
    U={};
    ['uRes','uOrig','uDpr','uSize','uRad','uBaseOn','uS','uNS','uK','uBezel','uThick','uIor','uDisp','uCurv','uLight','uLightH','uShine','uGain','uPress','uFinger','uFingerR','uLens','uMode','uBg','uBlur','uTint','uTintA']
      .forEach(n=>{U[n]=gl.getUniformLocation(prog,n);});
    if(!dummyTex){
      const buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
      dummyTex=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,dummyTex);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([0,0,0,255]));
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);
    }
    return true;
  }
  function initGL(){
    try{
      glc=document.createElement('canvas');glc.width=glc.height=4;
      const o={alpha:true,premultipliedAlpha:true,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false,powerPreference:'low-power'};
      gl=glc.getContext('webgl',o)||glc.getContext('experimental-webgl',o);
      if(!gl)return false;
      glc.addEventListener('webglcontextlost',e=>{e.preventDefault();glOK=false;});
      glc.addEventListener('webglcontextrestored',()=>{prog=null;dummyTex=null;glOK=buildProgram(prof().q);if(lab)lab.tex=null;markAll();});
      glOK=buildProgram(prof().q);
      return glOK;
    }catch(_){return false;}
  }

  /* 一次绘制：P 是参数表，结果拷进 target 2D 画布 */
  function draw(target,ctx2d,P){
    if(!glOK||!gl.isContextLost||gl.isContextLost())return false;
    const W=target.width,H=target.height;
    if(!W||!H)return false;
    if(glc.width<W||glc.height<H){glc.width=Math.max(glc.width,W);glc.height=Math.max(glc.height,H);}
    gl.viewport(0,0,W,H);
    gl.useProgram(prog);
    gl.uniform2f(U.uRes,W,H);gl.uniform2f(U.uOrig,P.mx||0,P.my||0);gl.uniform1f(U.uDpr,P.dpr);
    gl.uniform2f(U.uSize,P.w,P.h);
    const r=P.rad||[0,0,0,0];gl.uniform4f(U.uRad,r[0],r[1],r[2],r[3]);
    gl.uniform1f(U.uBaseOn,P.base?1:0);
    const sh=P.shapes||[];
    const arr=new Float32Array(MAXS*4);
    for(let i=0;i<sh.length&&i<MAXS;i++){arr[i*4]=sh[i][0];arr[i*4+1]=sh[i][1];arr[i*4+2]=sh[i][2];arr[i*4+3]=sh[i][3];}
    gl.uniform4fv(U.uS,arr);gl.uniform1f(U.uNS,Math.min(sh.length,MAXS));gl.uniform1f(U.uK,P.k||16);
    gl.uniform1f(U.uBezel,P.B);gl.uniform1f(U.uThick,P.T);gl.uniform1f(U.uIor,1.5);gl.uniform1f(U.uDisp,P.disp);gl.uniform1f(U.uCurv,CURV);
    gl.uniform2f(U.uLight,P.lx,P.ly);gl.uniform1f(U.uLightH,P.lh);gl.uniform1f(U.uShine,P.shine||80);
    gl.uniform1f(U.uGain,P.gain);gl.uniform1f(U.uPress,P.press||0);
    gl.uniform3f(U.uFinger,P.fx||0,P.fy||0,P.fk||0);gl.uniform1f(U.uFingerR,P.fr||26);
    gl.uniform1f(U.uLens,refractOK?0:1);
    gl.uniform1f(U.uMode,P.mode||0);
    gl.uniform1f(U.uBlur,P.blur||1);
    const t=P.tint||[.12,.13,.16];gl.uniform3f(U.uTint,t[0],t[1],t[2]);gl.uniform1f(U.uTintA,P.tintA||0);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,P.tex||dummyTex);gl.uniform1i(U.uBg,0);
    gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    ctx2d.setTransform(1,0,0,1,0,0);
    ctx2d.clearRect(0,0,W,H);
    ctx2d.drawImage(glc,0,glc.height-H,W,H,0,0,W,H);
    return true;
  }

  /* ---------- 几何（JS 端与 GLSL 同一套公式） ---------- */
  const CURV=.62,IOR=1.5,BULGE=.16;
  function readRadii(el,w,h){
    const cs=getComputedStyle(el);
    const one=v=>{const m=String(v||'0').match(/([\d.]+)(px|%)?/);if(!m)return 0;const n=parseFloat(m[1]);return m[2]==='%'?n/100*Math.min(w,h):n;};
    const mx=Math.min(w,h)/2;
    return [one(cs.borderTopLeftRadius),one(cs.borderTopRightRadius),one(cs.borderBottomRightRadius),one(cs.borderBottomLeftRadius)].map(v=>clamp(v,0,mx));
  }
  function sdRB(x,y,hw,hh,r){const qx=Math.abs(x)-(hw-r),qy=Math.abs(y)-(hh-r);return Math.min(Math.max(qx,qy),0)+Math.hypot(Math.max(qx,0),Math.max(qy,0))-r;}
  function sdRBr(x,y,hw,hh,rad){
    const r=x<0?(y<0?rad[0]:rad[3]):(y<0?rad[1]:rad[2]);
    return sdRB(x,y,hw,hh,r);
  }
  function slopeAt(t){const u=1-t,u3=u*u*u;return Math.min(CURV*u3*Math.pow(Math.max(1-u3*u,1e-3),-.75),6);}
  function refractMag(s,ior,T){
    const th=Math.atan(s),tt=Math.asin(Math.min(.999,Math.sin(th)/ior));
    return T*Math.tan(th-tt);
  }

  /* ---------- Chromium：SDF → 位移图 → SVG 折射滤镜 ---------- */
  function buildMap(st){
    const {w,h,rad,B,T}=st;
    /* 大元素位移图降采样，低档再降一级：位移图是平滑场，1/2~1/3 分辨率看不出 */
    const sc=w*h>140000?.5:(tier==='mid'&&w*h>60000?.66:1);
    const mw=Math.max(2,Math.round(w*sc)),mh=Math.max(2,Math.round(h*sc));
    const cv=document.createElement('canvas');cv.width=mw;cv.height=mh;
    const cx=cv.getContext('2d');
    const img=cx.createImageData(mw,mh);
    new Uint32Array(img.data.buffer).fill(0xFF808080);
    const TN=96,tab=new Float32Array(TN+1);let S=.001;
    for(let i=0;i<=TN;i++){const t=Math.max(i/TN,.02);tab[i]=refractMag(slopeAt(t),IOR,T);if(tab[i]>S)S=tab[i];}
    const hw=w/2,hh=h/2,e=.75;
    for(let y=0;y<mh;y++){
      for(let x=0;x<mw;x++){
        const px=(x+.5)/sc-hw,py=(y+.5)/sc-hh;
        const d=sdRBr(px,py,hw,hh,rad);
        if(d>=0)continue;
        const k=(y*mw+x)*4;
        if(d<=-B){const bx=-px/hw*BULGE,by=-py/hh*BULGE;img.data[k]=128+127*bx;img.data[k+1]=128+127*by;img.data[k+2]=128;img.data[k+3]=255;continue;}
        let gx=sdRBr(px+e,py,hw,hh,rad)-sdRBr(px-e,py,hw,hh,rad),gy=sdRBr(px,py+e,hw,hh,rad)-sdRBr(px,py-e,hw,hh,rad);
        const l=Math.hypot(gx,gy)||1;gx/=l;gy/=l;
        const off=tab[Math.min(TN,((-d/B)*TN)|0)]/S;
        const ux=clamp(-gx*off-px/hw*BULGE,-1,1),uy=clamp(-gy*off-py/hh*BULGE,-1,1);
        img.data[k]=128+127*ux;img.data[k+1]=128+127*uy;img.data[k+2]=128;img.data[k+3]=255;
      }
    }
    cx.putImageData(img,0,0);
    return {url:cv.toDataURL('image/png'),S};
  }
  const svgNS='http://www.w3.org/2000/svg';
  function makeDefs(){
    if(defs)return;
    const svg=document.createElementNS(svgNS,'svg');
    svg.setAttribute('width','0');svg.setAttribute('height','0');svg.setAttribute('aria-hidden','true');
    svg.style.cssText='position:absolute;pointer-events:none';
    defs=document.createElementNS(svgNS,'defs');svg.appendChild(defs);
    document.body.appendChild(svg);
  }
  function svgEl(n,a){const e=document.createElementNS(svgNS,n);for(const k in a)e.setAttribute(k,a[k]);return e;}
  function applyFilter(st){
    if(!refractOK||!defs||!st.w||!st.h)return;
    const key=[st.w,st.h,st.rad.join(','),st.B,tier].join('|');
    if(key===st.mapKey)return;st.mapKey=key;
    const m=buildMap(st);
    const disp=prof().disp;
    const base=refractMag(slopeAt(.03),IOR,st.T);
    const sG=2*m.S,sR=sG*(refractMag(slopeAt(.03),IOR-disp,st.T)/base),sB=sG*(refractMag(slopeAt(.03),IOR+disp,st.T)/base);
    const old=document.getElementById(st.fid);if(old)old.remove();
    const f=svgEl('filter',{id:st.fid,x:0,y:0,width:st.w,height:st.h,filterUnits:'userSpaceOnUse',primitiveUnits:'userSpaceOnUse','color-interpolation-filters':'sRGB'});
    const im=svgEl('feImage',{x:0,y:0,width:st.w,height:st.h,preserveAspectRatio:'none',result:'map'});
    im.setAttribute('href',m.url);
    f.appendChild(im);
    const ch=(id,scale,mat)=>{
      f.appendChild(svgEl('feDisplacementMap',{in:'SourceGraphic',in2:'map',scale:scale.toFixed(2),xChannelSelector:'R',yChannelSelector:'G',result:'d'+id}));
      f.appendChild(svgEl('feColorMatrix',{in:'d'+id,type:'matrix',values:mat,result:'c'+id}));
    };
    ch('R',sR,'1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0');
    ch('G',sG,'0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0');
    ch('B',sB,'0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0');
    f.appendChild(svgEl('feComposite',{in:'cR',in2:'cG',operator:'arithmetic',k1:0,k2:1,k3:1,k4:0,result:'rg'}));
    f.appendChild(svgEl('feComposite',{in:'rg',in2:'cB',operator:'arithmetic',k1:0,k2:1,k3:1,k4:0}));
    defs.appendChild(f);
    st.el.style.setProperty('--lg-filter','url(#'+st.fid+')');
    st.el.setAttribute('data-lg-refract','1');
  }
  function stripFilter(st){
    const old=document.getElementById(st.fid);if(old)old.remove();
    st.el.style.removeProperty('--lg-filter');st.el.removeAttribute('data-lg-refract');st.mapKey='';
  }
  /* 折射开关：档位切换时整体启停，CSS 靠根节点属性联动 */
  function setRefract(on){
    if(on===refractOK)return;
    refractOK=on;
    if(on){makeDefs();root.setAttribute('data-lg-refract','1');reg.forEach(st=>{st.mapKey='';if(st.w)applyFilter(st);});}
    else{root.removeAttribute('data-lg-refract');reg.forEach(stripFilter);}
  }

  /* ---------- 元素注册 ---------- */
  const ro=new ResizeObserver(es=>{es.forEach(e=>{const st=reg.get(e.target);if(st){measure(st);schedule();}});});
  const io=new IntersectionObserver(es=>{es.forEach(e=>{const st=reg.get(e.target);if(st){st.visible=e.isIntersecting;if(st.visible){st.dirty=true;schedule();}}});});
  function add(elm){
    if(!enabled||reg.has(elm))return;
    const st={el:elm,cv:document.createElement('canvas'),ctx:null,w:0,h:0,dpr:1,big:false,rad:[28,28,28,28],B:16,T:14,
      dirty:true,visible:false,press:0,pressT:0,fg:{x:0,y:0,k:0,kT:0,down:false},fid:'lgf'+(++uid),mapKey:'',on:false,mapTimer:0,
      M:elm.id==='dock'?18:(elm.classList.contains('h-btn')&&!isIOS?12:0),small:elm.classList.contains('h-btn'),
      tr:{x:0,y:0,vx:0,vy:0,init:false},ctl:null};
    st.cv.className='lg-canvas';st.cv.setAttribute('aria-hidden','true');
    st.ctx=st.cv.getContext('2d');
    elm.insertBefore(st.cv,elm.firstChild);
    reg.set(elm,st);
    ro.observe(elm);io.observe(elm);
    measure(st);
  }
  function measure(st){
    const w=st.el.offsetWidth,h=st.el.offsetHeight;
    if(!w||!h)return false;
    const P=prof();
    st.big=w*h>120000;
    st.dpr=Math.min(devicePixelRatio||1,st.big?P.dprB:P.dprS);
    const changed=(w!==st.w||h!==st.h);
    st.w=w;st.h=h;
    st.rad=readRadii(st.el,w,h);
    st.B=clamp(Math.min(w,h)*.36,9,30);st.T=st.B*1.05;
    const M=st.M,cw=Math.round((w+2*M)*st.dpr),ch=Math.round((h+2*M)*st.dpr);
    if(st.cv.width!==cw||st.cv.height!==ch){st.cv.width=cw;st.cv.height=ch;}
    if(M){const c=st.cv.style;c.inset='-'+M+'px';c.width=(w+2*M)+'px';c.height=(h+2*M)+'px';c.borderRadius='0';}
    if(changed&&refractOK){
      clearTimeout(st.mapTimer);
      st.mapTimer=setTimeout(()=>applyFilter(st),st.mapKey?90:0);
    }
    st.dirty=true;
    return true;
  }
  function markAll(){reg.forEach(s=>{s.dirty=true;});if(lab)lab.dirty=true;schedule();}

  /* ---------- 光源与交互 ---------- */
  function restLight(now){
    const t=now*.00035,dr=(prof().drift&&!still&&!reduceMotion());
    return {x:innerWidth*(.30+(dr?Math.sin(t)*.10:0)),y:-innerHeight*.10+(dr?Math.cos(t*.8)*20:0)};
  }
  function onMove(e){L.on=true;L.tx=e.clientX;L.ty=e.clientY;boostUntil=performance.now()+1400;schedule();}
  function onDown(e){
    onMove(e);
    const t=e.target&&e.target.closest?e.target.closest('[data-glass]'):null;
    const st=t&&reg.get(t);
    if(st&&!still&&!reduceMotion()){
      const r=t.getBoundingClientRect();
      st.fg.down=true;st.fg.x=(e.clientX-r.left)*st.w/(r.width||1);st.fg.y=(e.clientY-r.top)*st.h/(r.height||1);
      st.fg.kT=1;st.pressT=1;
      const c=e.target.closest('button,.icon-in,#send,.h-btn');st.ctl=(c&&t.contains(c)&&c!==t)?c:null;
    }
    if(lab)labPointer(e,true);
  }
  function onUp(){
    L.on=false;boostUntil=performance.now()+900;
    reg.forEach(s=>{s.fg.down=false;s.fg.kT=0;s.pressT=0;});
    if(lab)lab.ptr.on=false;
    schedule();
  }
  function onPointerMove(e){
    onMove(e);
    reg.forEach(s=>{
      if(!s.fg.down)return;
      const r=s.el.getBoundingClientRect();
      s.fg.x=(e.clientX-r.left)*s.w/(r.width||1);s.fg.y=(e.clientY-r.top)*s.h/(r.height||1);
    });
    if(lab&&lab.ptr.on)labPointer(e,false);
  }
  function intensityFromCss(){
    try{
      const cs=getComputedStyle(root);
      const o=parseFloat(cs.getPropertyValue('--glass-o')),b=parseFloat(cs.getPropertyValue('--glass-b'));
      if(Number.isFinite(o))I.o=o;if(Number.isFinite(b))I.b=b;
    }catch(_){}
  }
  function setIntensity(o,b){
    if(Number.isFinite(o))I.o=o;if(Number.isFinite(b))I.b=b;
    if(enabled)markAll();
  }

  /* ---------- Governor：实测掉帧就降一档，只降不升 ---------- */
  const gov={slow:0,busyPrev:false,on:true};
  function govern(dt){
    if(!gov.on||document.hidden)return;
    if(!gov.busyPrev||dt>.25){gov.slow=Math.max(0,gov.slow-1);return;}
    /* 40ms 以上才算慢：iOS 低电量模式锁 30fps（33ms），不该被误判 */
    if(dt>.040)gov.slow+=2;else if(dt<.024)gov.slow=Math.max(0,gov.slow-1);
    if(gov.slow>=24){
      gov.slow=0;
      const i=TIERS.indexOf(tier);
      if(i>0){saveCap(TIERS[i-1]);applyTier(TIERS[i-1]);}
    }
  }

  /* ---------- 帧循环 ---------- */
  function schedule(){if(!enabled)return;if(!rafId)rafId=requestAnimationFrame(frame);}
  /* 融合形状：按压生成液滴，后面拖一颗带弹簧的尾巴，快滑时拉出粘连液桥；返回 {shapes,k,more} */
  function buildShapes(st,r,sx,sy){
    const shapes=[],pr=st.press;
    let kk=st.small?15:20,more=false;
    if(pr>.01){
      let cx,cy,rx,ry;
      if(st.ctl&&st.ctl.isConnected){
        const c=st.ctl.getBoundingClientRect(),infl=(st.M?20:8)*pr;
        cx=(c.left-r.left+c.width/2)*sx;cy=(c.top-r.top+c.height/2)*sy;rx=c.width/2*sx+infl;ry=c.height/2*sy+infl;
      }else if(st.small){
        const ox=clamp(st.fg.x-st.w/2,-st.w*.7,st.w*.7)*.6,oy=clamp(st.fg.y-st.h/2,-st.h*.7,st.h*.7)*.6;
        cx=st.w/2+ox;cy=st.h/2+oy;rx=ry=Math.min(st.w,st.h)*.34+9*pr;
      }else if(st.M){cx=st.fg.x;cy=st.h/2;rx=8+36*pr;ry=st.h/2+10*pr;}
      else{cx=st.fg.x;cy=st.fg.y;rx=ry=6+26*pr;}
      shapes.push([cx,cy,rx,ry]);
      const T=st.tr;
      if(!T.init){T.x=cx;T.y=cy;T.vx=T.vy=0;T.init=true;}
      const ns=Math.max(1,Math.ceil(curDt/.008)),hs=curDt/ns;
      for(let i=0;i<ns;i++){T.vx+=((cx-T.x)*150-T.vx*12)*hs;T.vy+=((cy-T.y)*150-T.vy*12)*hs;T.x+=T.vx*hs;T.y+=T.vy*hs;}
      const lag=Math.hypot(cx-T.x,cy-T.y);
      if(lag>1.5)shapes.push([T.x,T.y,rx*.8,ry*.8]);
      if(lag>.4||Math.hypot(T.vx,T.vy)>2)more=true;
      kk*=1+Math.min(.6,lag/40);
    }else st.tr.init=false;
    return {shapes,k:kk,more};
  }
  /* 画一个元素；返回是否还需要续帧 */
  function paintEl(st){
    /* 位置只在这次绘制开头量一次，buildShapes 与光源换算都复用，避免每帧多一次布局 */
    const r=st.el.getBoundingClientRect();
    const sx=st.w/(r.width||1),sy=st.h/(r.height||1);
    const P=prof(),pr=st.press;
    const S=buildShapes(st,r,sx,sy);
    const ok=draw(st.cv,st.ctx,{
      dpr:st.dpr,w:st.w,h:st.h,rad:st.rad,base:true,B:st.B,T:st.T,disp:P.disp,mx:st.M,shapes:S.shapes,k:S.k*(.8+.5*pr),
      lx:(L.rx-r.left)*sx,ly:(L.ry-r.top)*sy,lh:Math.max(40,L.h*Math.max(st.w,st.h)*.6+30),
      gain:.6+.2*Math.min(I.o,2),press:pr,shine:P.shine,
      fx:st.fg.x,fy:st.fg.y,fk:st.fg.k*4.5,fr:Math.max(18,Math.min(st.w,st.h)*.5)
    });
    if(ok&&!st.on){st.on=true;st.el.setAttribute('data-lg','1');}
    st.dirty=S.more;
    return S.more;
  }
  function frame(now){
    rafId=0;
    const P=prof();
    /* 低档限帧：没到间隔就顺延到下一帧，dt 照实累计 */
    if(P.fps&&lastPaint&&now-lastPaint<1000/P.fps-2){schedule();return;}
    const raw=(now-lastT)/1000;
    const dt=Math.min(.05,raw||.016);lastT=now;curDt=dt;lastPaint=now;
    govern(raw);
    let busy=false;
    const rest=restLight(now);
    const tx=L.on?L.tx:rest.x,ty=L.on?L.ty:rest.y;
    const k=1-Math.exp(-dt*(L.on?20:2.4));
    if(L.rx<-900){L.rx=tx;L.ry=ty;}
    const dx=tx-L.rx,dy=ty-L.ry;
    L.rx+=dx*k;L.ry+=dy*k;
    L.h+=((L.on?.6:.8)-L.h)*k;
    const lightMoving=Math.abs(dx)>.4||Math.abs(dy)>.4;
    if(lightMoving)busy=true;
    const follow=L.on||now<boostUntil;
    reg.forEach(st=>{
      if(!st.visible)return;
      const ks=1-Math.exp(-dt*(st.pressT>st.press?26:12));
      if(Math.abs(st.fg.k-st.fg.kT)>.005){st.fg.k+=(st.fg.kT-st.fg.k)*ks;st.dirty=true;busy=true;}else st.fg.k=st.fg.kT;
      if(Math.abs(st.press-st.pressT)>.005){st.press+=(st.pressT-st.press)*ks;st.dirty=true;busy=true;}else st.press=st.pressT;
      /* 光源在动：输入栏一直跟；其余元素只在手指/余韵期跟，大元素在中低档不跟 */
      if(lightMoving&&(st.el.id==='dock'||(follow&&(P.bigFollow||!st.big))))st.dirty=true;
      if(st.dirty){if(!st.w&&!measure(st))return;if(paintEl(st))busy=true;}
    });
    if(lab&&lab.visible&&lab.dirty){paintLab(now,dt);if(lab.anim)busy=true;}
    gov.busyPrev=busy;
    if(busy||now<boostUntil)schedule();
    else if(P.drift&&!still&&!reduceMotion()&&!document.hidden){
      clearTimeout(driftTimer);driftTimer=setTimeout(()=>{if(!document.hidden){lastT=performance.now();frame(performance.now());}},80);
    }
  }

  /* ---------- 实验室：设置页里的玻璃预览（自带背景 → 全量折射） ---------- */
  function mountLab(preview,pill){
    if(!enabled||!preview||!pill||lab)return;
    const cv=document.createElement('canvas');cv.className='lg-lab';cv.setAttribute('aria-hidden','true');
    preview.insertBefore(cv,preview.firstChild);
    lab={preview,pill,cv,ctx:cv.getContext('2d'),w:0,h:0,dpr:1,bgc:document.createElement('canvas'),tex:null,dirty:true,visible:false,anim:false,
      orb:{x:0,y:0,vx:0,vy:0,r:21},sat:{a:0},ptr:{on:false,x:0,y:0},t0:performance.now(),bgKey:''};
    const lro=new ResizeObserver(()=>{labMeasure();schedule();});lro.observe(preview);
    const lio=new IntersectionObserver(es=>{lab.visible=es[0].isIntersecting;if(lab.visible){lab.dirty=true;if(!labMeasure())return;lab.anim=!still&&!reduceMotion();schedule();}});lio.observe(preview);
    preview.addEventListener('pointerdown',e=>{lab.ptr.on=true;labPointer(e,true);},{passive:true});
    preview.classList.add('lg-on');
    labMeasure();
  }
  function labMeasure(){
    if(!lab)return false;
    const w=lab.preview.clientWidth,h=lab.preview.clientHeight;
    if(!w||!h)return false;
    const dpr=Math.min(devicePixelRatio||1,prof().dprS);
    if(w!==lab.w||h!==lab.h||!lab.tex||dpr!==lab.dpr){
      lab.dpr=dpr;lab.w=w;lab.h=h;
      lab.cv.width=Math.round(w*lab.dpr);lab.cv.height=Math.round(h*lab.dpr);
      lab.orb.x=lab.orb.tx=w*.80;lab.orb.y=lab.orb.ty=h*.34;
      lab.tex=null;
    }
    lab.dirty=true;return true;
  }
  function labPointer(e){
    if(!lab)return;
    const r=lab.preview.getBoundingClientRect();
    lab.ptr.x=clamp(e.clientX-r.left,0,lab.w);lab.ptr.y=clamp(e.clientY-r.top,0,lab.h);
    lab.dirty=true;lab.anim=!still&&!reduceMotion();schedule();
  }
  function rgbVar(name,fb){
    const v=getComputedStyle(root).getPropertyValue(name).trim();
    const m=v.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);return m?[+m[1],+m[2],+m[3]]:fb;
  }
  function paintLabBg(){
    const c=lab.bgc,w=lab.w,h=lab.h,s=lab.dpr;
    c.width=Math.round(w*s);c.height=Math.round(h*s);
    const x=c.getContext('2d');x.setTransform(s,0,0,s,0,0);
    const ac=rgbVar('--accent-rgb',[158,192,232]),ro=rgbVar('--rose-rgb',[230,186,212]);
    let g=x.createLinearGradient(0,0,w*.5,h);g.addColorStop(0,'#2b3038');g.addColorStop(1,'#14171c');x.fillStyle=g;x.fillRect(0,0,w,h);
    g=x.createRadialGradient(w*.26,0,0,w*.26,0,w*.7);g.addColorStop(0,`rgba(${ac},.42)`);g.addColorStop(1,`rgba(${ac},0)`);x.fillStyle=g;x.fillRect(0,0,w,h);
    g=x.createRadialGradient(w*.82,h*1.05,0,w*.82,h*1.05,w*.6);g.addColorStop(0,`rgba(${ro},.40)`);g.addColorStop(1,`rgba(${ro},0)`);x.fillStyle=g;x.fillRect(0,0,w,h);
    /* 仿聊天内容：气泡 + 文字条 + 色点，边缘折射时能看出形变 */
    const rr=(X,Y,W,H,R,fill)=>{x.beginPath();x.roundRect?x.roundRect(X,Y,W,H,R):x.rect(X,Y,W,H);x.fillStyle=fill;x.fill();};
    rr(w*.06,h*.10,w*.46,h*.26,14,'rgba(255,255,255,.10)');
    for(let i=0;i<3;i++)rr(w*.09,h*.15+i*10,w*(.36-i*.07),4,2,'rgba(255,255,255,.55)');
    rr(w*.50,h*.30,w*.44,h*.26,14,`rgba(${ac},.75)`);
    for(let i=0;i<3;i++)rr(w*.53,h*.35+i*10,w*(.36-i*.06),4,2,'rgba(10,42,72,.8)');
    for(let i=0;i<9;i++){x.beginPath();x.arc(w*(.08+i*.105),h*.62+((i%2)*9),3.2,0,7);x.fillStyle=i%3===0?`rgba(${ro},.9)`:i%3===1?`rgba(${ac},.9)`:'rgba(255,255,255,.8)';x.fill();}
    x.strokeStyle='rgba(255,255,255,.12)';x.lineWidth=1;
    for(let i=1;i<10;i++){x.beginPath();x.moveTo(w*i/10,0);x.lineTo(w*i/10,h);x.stroke();}
    lab.bgKey=[w,h,ac.join(),ro.join()].join('|');
  }
  function labUpload(){
    const key=[lab.w,lab.h,lab.dpr,rgbVar('--accent-rgb',[0,0,0]).join()].join('|');
    if(lab.tex&&lab.texKey===key)return;
    paintLabBg();
    if(lab.tex)gl.deleteTexture(lab.tex);
    const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,lab.bgc);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    lab.tex=t;lab.texKey=key;
  }
  function paintLab(now,dt){
    if(!labMeasure())return;
    try{labUpload();}catch(_){return;}
    const o=lab.orb,p=lab.ptr;
    const t=(now-lab.t0)/1000;
    const still_=still||reduceMotion();
    const tx=p.on?p.x:lab.w*.80+(still_?0:Math.sin(t*.9)*6),ty=p.on?p.y:lab.h*.34+(still_?0:Math.cos(t*1.1)*5);
    const stepDt=Math.min(dt||.016,.05);
    o.vx+=((tx-o.x)*90-o.vx*14)*stepDt;o.vy+=((ty-o.y)*90-o.vy*14)*stepDt;
    o.x+=o.vx*stepDt;o.y+=o.vy*stepDt;
    const rT=p.on?25:21;o.r+=(rT-o.r)*Math.min(1,stepDt*12);
    lab.sat.a+=stepDt*(still_?0:1.3);
    const sa=lab.sat.a,sr=9;
    const pr=lab.pill.getBoundingClientRect(),vr=lab.preview.getBoundingClientRect();
    const pill=[pr.left-vr.left+pr.width/2,pr.top-vr.top+pr.height/2,pr.width/2,pr.height/2];
    const orb=[o.x,o.y,o.r*(1+clamp(Math.hypot(o.vx,o.vy)/900,0,.12)),o.r*(1-clamp(Math.hypot(o.vx,o.vy)/900,0,.08))];
    const sat=[o.x+Math.cos(sa)*(o.r+15),o.y+Math.sin(sa)*(o.r+15),sr,sr];
    const tint=rgbVar('--glass-tint-rgb',[30,34,40]).map(v=>v/255);
    draw(lab.cv,lab.ctx,{
      dpr:lab.dpr,w:lab.w,h:lab.h,base:false,shapes:[pill,orb,sat],k:18,mode:1,tex:lab.tex,
      B:13,T:15,disp:prof().disp+.03,
      lx:L.rx-vr.left,ly:L.ry-vr.top,lh:70,gain:.85+.25*Math.min(I.o,2),press:p.on?.2:0,shine:70,
      fx:p.on?p.x:0,fy:p.on?p.y:0,fk:0,
      blur:.8+5.5*clamp((I.b-.45)/1.3,0,1),tint,tintA:clamp(.04+.09*I.o,0,.5)
    });
    lab.dirty=lab.anim;
  }

  /* ---------- 档位切换 / 入口 ---------- */
  function afterTierChange(){
    /* 模糊倍率随档位变：让设置里的滑块映射重算一遍 */
    /* 浓度取全局无障碍设置里的 a11y.glass；本层没这层数据就用 CSS 变量解析出的 I.o 兜底 */
    try{
      if(typeof applyGlassIntensity==='function'){
        const g=(typeof a11y!=='undefined'&&a11y&&Number.isFinite(a11y.glass))?a11y.glass:I.o*100;
        applyGlassIntensity(Math.max(0,Math.min(100,g)));
      }
    }catch(_){}
  }
  function applyTier(t){
    if(t===tier||TIERS.indexOf(t)<0)return;
    const prevQ=prof().q;
    tier=t;root.setAttribute('data-glass-tier',t);
    if(!enabled){afterTierChange();return;}
    if(prof().q!==prevQ&&glOK){try{glOK=buildProgram(prof().q);}catch(_){glOK=false;}}
    const was=refractOK;
    setRefract(refractCapable&&prof().refract);
    if(refractOK&&was)reg.forEach(st=>{st.mapKey='';if(st.w)applyFilter(st);});   /* 色散强度随档位变 */
    reg.forEach(measure);
    if(lab){lab.tex=null;labMeasure();}
    afterTierChange();
    markAll();
    try{console.info('[LiquidGlass] tier→'+t);}catch(_){}
  }
  function init(){
    if(inited)return;inited=true;
    try{
      if(qs.get('lg')==='off'||Store.getItem('dl.lg')==='off'){tier='low';root.setAttribute('data-glass-tier','low');afterTierChange();return;}
    }catch(_){}
    const gpu=probeGPU();
    /* 没有 WebGL 或只有软件渲染：整个引擎不开，落回纯 CSS 玻璃 */
    if(gpu.none||gpu.sw&&!qs.get('lgtier')){tier='low';root.setAttribute('data-glass-tier','low');afterTierChange();return;}
    const d=detectTier(gpu);
    tier=d.t;
    gov.on=!d.forced||qs.get('lggov')==='1';
    root.setAttribute('data-glass-tier',tier);
    try{console.info('[LiquidGlass] tier='+tier);}catch(_){}
    if(!initGL()){tier='low';root.setAttribute('data-glass-tier','low');afterTierChange();return;}
    enabled=true;
    still=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
    /* SVG 位移折射仅 Chromium 支持；Safari/Firefox 无 */
    let cssOK=false;try{cssOK=CSS.supports('backdrop-filter','url(#a)');}catch(_){}
    let lgrOff=false;try{lgrOff=Store.getItem('dl.lgr')==='0';}catch(_){}
    refractCapable=isChromium&&cssOK&&qs.get('lgr')!=='0'&&!lgrOff;
    if(isIOS)root.setAttribute('data-lg-ios','1');
    root.setAttribute('data-lg-on','1');
    if(refractCapable&&prof().refract){refractOK=true;makeDefs();root.setAttribute('data-lg-refract','1');}
    afterTierChange();
    intensityFromCss();
    document.addEventListener('pointermove',onPointerMove,{passive:true});
    document.addEventListener('pointerdown',onDown,{passive:true,capture:true});
    document.addEventListener('pointerup',onUp,{passive:true,capture:true});
    document.addEventListener('pointercancel',onUp,{passive:true,capture:true});
    window.addEventListener('resize',()=>{reg.forEach(s=>measure(s));if(lab)labMeasure();schedule();},{passive:true});
    document.addEventListener('visibilitychange',()=>{gov.slow=0;if(!document.hidden){lastT=performance.now();markAll();}});
    document.querySelectorAll('[data-glass]').forEach(add);
    const prev=document.querySelector('.glass-preview'),pill=document.querySelector('.glass-preview-dock');
    if(prev&&pill)mountLab(prev,pill);
    schedule();
  }
  return {init,add,mountLab,setIntensity,setTier:applyTier,getTier:()=>tier,isEnabled:()=>enabled,refresh:markAll,blurScale:()=>prof().blur,debug:()=>({gov:{...gov},dt:curDt,tier})};
})();


/* =========================================================
   ██ GlassLens · 液态玻璃的"手感"层 ██
   独立于 WebGL，任何档位都生效（减弱动态效果时自动关闭）：
   ① 弹性拖拽：按住玻璃往任意方向拉，玻璃跟着手指走，但越拉越费劲（橡皮筋阻尼）；
      拉伸方向变长、垂直方向变扁（体积守恒的挤压拉伸）；松手后欠阻尼弹簧带一点过冲再回位。
   ② 透镜放大：手指按住/滑动时，玻璃上的图标、输入文字像被一枚凸透镜罩住，
      以手指为中心高斯衰减地放大，并被向外挤开一点（鱼眼位移）；松手时弹回。
   用的是 CSS 独立属性 translate / scale，不碰 transform，
   所以不会跟原来的按压缩放、回弹动画抢同一个属性。
========================================================= */
const GlassLens=(()=>{
  const clamp=(x,a,b)=>x<a?a:x>b?b:x;
  const items=new Map();
  let raf=0,last=0,ready=false;
  const reduced=()=>{try{return (document.body&&document.body.getAttribute('data-motion')==='reduce')||matchMedia('(prefers-reduced-motion: reduce)').matches;}catch(_){return false;}};
  /* 橡皮筋：位移越大越拉不动，上限趋近 c */
  const rb=(d,c)=>{const a=Math.abs(d);return (d<0?-1:1)*c*(1-1/(a*.55/c+1));};
  function cfgOf(el){
    if(el.classList.contains('h-btn'))return {cx:16,cy:16,amp:.55,sig:40,smax:.16};
    if(el.id==='dock')return {cx:30,cy:16,amp:.42,sig:46,smax:.05};
    return null;
  }
  function collect(el){
    const list=[],k=cfgOf(el);
    const hr=el.getBoundingClientRect(),f=el.offsetWidth/(hr.width||1);
    const add=(n,amp,txt)=>{
      const r=n.getBoundingClientRect();if(!r.width||!r.height)return;
      list.push({n,lx:(r.left-hr.left)*f,ly:(r.top-hr.top)*f,w:r.width*f,h:r.height*f,amp,txt:!!txt});
    };
    if(el.classList.contains('h-btn')){const s=el.querySelector('svg');if(s)add(s,k.amp);}
    else{
      el.querySelectorAll('.icon-in,#send').forEach(n=>add(n,k.amp));
      const ta=el.querySelector('textarea');if(ta)add(ta,.13,true);
    }
    return list;
  }
  function locate(S,e){
    const r=S.el.getBoundingClientRect(),f=S.el.offsetWidth/(r.width||1);
    S.fx=(e.clientX-r.left)*f;S.fy=(e.clientY-r.top)*f;
  }
  function onDown(e){
    if(!ready||(e.button>0)||reduced())return;
    const t=e.target;if(!t||!t.closest)return;
    const el=t.closest('[data-glass]');if(!el)return;
    const k=cfgOf(el);if(!k)return;
    /* 鼠标在输入框里拖动是选文字，别拉玻璃 */
    if(e.pointerType==='mouse'&&t.closest('textarea,input'))return;
    let S=items.get(el);
    if(!S){
      S={el,k,x:0,y:0,vx:0,vy:0,tx:0,ty:0,m:0,mv:0,down:false,pid:-1,x0:0,y0:0,fx:0,fy:0,list:collect(el)};
      items.set(el,S);
    }
    S.down=true;S.pid=e.pointerId;S.x0=e.clientX;S.y0=e.clientY;S.tx=S.ty=0;
    locate(S,e);
    if(!raf){last=performance.now();raf=requestAnimationFrame(frame);}
  }
  function onMove(e){
    if(!items.size)return;
    items.forEach(S=>{
      if(!S.down||e.pointerId!==S.pid)return;
      S.tx=rb(e.clientX-S.x0,S.k.cx);S.ty=rb(e.clientY-S.y0,S.k.cy);
      locate(S,e);
    });
    if(!raf)raf=requestAnimationFrame(frame);
  }
  function onUp(e){
    items.forEach(S=>{if(S.down&&(e.type==='pointercancel'||e.pointerId===S.pid)){S.down=false;S.tx=S.ty=0;}});
    if(items.size&&!raf)raf=requestAnimationFrame(frame);
  }
  function apply(S){
    const el=S.el,k=S.k;
    const len=Math.hypot(S.x,S.y),spd=Math.hypot(S.vx,S.vy);
    const ux=len>.01?S.x/len:0,uy=len>.01?S.y/len:0;
    const a=k.smax*Math.min(1.4,len/k.cx+spd/(k.cx*40));
    const sx=1+a*ux*ux-.5*a*uy*uy,sy=1+a*uy*uy-.5*a*ux*ux;
    el.style.translate=S.x.toFixed(2)+'px '+S.y.toFixed(2)+'px';
    el.style.scale=sx.toFixed(4)+' '+sy.toFixed(4);
    const m=S.m;
    for(const it of S.list){
      const cx=it.lx+it.w/2,cy=it.ly+it.h/2;
      let dx=cx-S.fx,dy=cy-S.fy;
      if(it.txt){dx=S.fx<it.lx?it.lx-S.fx:(S.fx>it.lx+it.w?S.fx-(it.lx+it.w):0);}
      const g=Math.exp(-(dx*dx+dy*dy)/(2*k.sig*k.sig));
      const s=1+it.amp*g*m;
      it.n.style.scale=s.toFixed(4);
      if(it.txt){it.n.style.transformOrigin=clamp(S.fx-it.lx,0,it.w).toFixed(1)+'px 50%';}
      else{it.n.style.translate=((cx-S.fx)*(s-1)*.9).toFixed(2)+'px '+((cy-S.fy)*(s-1)*.9).toFixed(2)+'px';}
    }
  }
  function clear(S){
    S.el.style.translate='';S.el.style.scale='';
    for(const it of S.list){it.n.style.scale='';it.n.style.translate='';it.n.style.transformOrigin='';}
  }
  function frame(now){
    raf=0;
    const dt=Math.min(.05,(now-last)/1000||.016);last=now;
    const n=Math.max(1,Math.ceil(dt/.008)),h=dt/n;
    let busy=false;
    items.forEach((S,el)=>{
      const d=S.down;
      /* 按住：接近临界阻尼，跟手；松开：欠阻尼(ζ≈0.43)，回弹时有肉眼可见的过冲 */
      const kp=d?280:150,cp=d?26:10.5,km=d?320:190,cm=d?30:12;
      for(let i=0;i<n;i++){
        S.vx+=((S.tx-S.x)*kp-S.vx*cp)*h;S.vy+=((S.ty-S.y)*kp-S.vy*cp)*h;
        S.x+=S.vx*h;S.y+=S.vy*h;
        S.mv+=(((d?1:0)-S.m)*km-S.mv*cm)*h;S.m+=S.mv*h;
      }
      const settled=!d&&Math.abs(S.x)<.04&&Math.abs(S.y)<.04&&Math.abs(S.vx)<.4&&Math.abs(S.vy)<.4&&Math.abs(S.m)<.003&&Math.abs(S.mv)<.05;
      if(settled){clear(S);items.delete(el);return;}
      busy=true;apply(S);
    });
    if(busy)raf=requestAnimationFrame(frame);
  }
  function init(){
    if(ready)return;
    try{if(!(CSS.supports('scale','1')&&CSS.supports('translate','1px')))return;}catch(_){return;}
    ready=true;
    document.addEventListener('pointerdown',onDown,{passive:true,capture:true});
    document.addEventListener('pointermove',onMove,{passive:true});
    document.addEventListener('pointerup',onUp,{passive:true,capture:true});
    document.addEventListener('pointercancel',onUp,{passive:true,capture:true});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)items.forEach(S=>{S.down=false;S.tx=S.ty=0;});});
  }
  return {init};
})();


/* ---- 浓度换算（原样取自主程序）---- */
function glassNum(v,fallback){const n=+v;return Number.isFinite(n)?n:fallback;}
function applyGlassIntensity(v){
  const n=Math.max(0,Math.min(100,glassNum(v,50)));
  const o=n<=50?(0.12+n/50*0.88):(1+(n-50)/50*2.4);
  const bs=(typeof LiquidGlass!=='undefined'&&LiquidGlass.blurScale)?LiquidGlass.blurScale():1;   /* 低档模糊半径更小，backdrop-filter 是中低端最大的开销 */
  const b=(0.45+n/100*1.3)*bs;
  document.documentElement.style.setProperty('--glass-o',o.toFixed(3));
  document.documentElement.style.setProperty('--glass-b',b.toFixed(3));
  try{if(typeof LiquidGlass!=='undefined')LiquidGlass.setIntensity(o,b);}catch(e){}
}

if(typeof window!=='undefined'){window.GlassMotion=GlassMotion;window.LiquidGlass=LiquidGlass;window.GlassLens=GlassLens;window.applyGlassIntensity=applyGlassIntensity;}
