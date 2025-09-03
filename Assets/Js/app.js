document.addEventListener('DOMContentLoaded', () => {
  /* ---------- State / UI helpers ---------- */
  let robotAt=0, sensor=0, busy=false, auto=false, stopFlag=false;
  let prevReady = false;

  const $ = (id)=>document.getElementById(id);
  const setLed = (id, cls)=> { $(id).className = "led " + (cls||""); }
  const log = (msg, cls="log-other") => {
    const t=new Date().toLocaleTimeString();
    $("log").innerHTML = `<div class="${cls}">[${t}] ${msg}</div>` + $("log").innerHTML;
  }
  const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
  const fill = (id, v)=> { $(id).style.width = v + "%"; }

  function refreshLEDs(){
    setLed("led_robot", robotAt ? "on" : "");
    setLed("led_sensor", sensor ? "on" : "");
    const ready = robotAt && sensor;
    setLed("led_ready", ready ? "on" : "");
    if (ready && !prevReady && !busy && !auto) processReadyCycle();
    prevReady = ready;
  }

  // --- Buttons ---
  $("btnRobot").onclick = ()=>{ setRobotAt(1 - robotAt); refreshLEDs(); };
  $("btnSensor").onclick = ()=>{ setSensor(1 - sensor);  refreshLEDs(); };

  $("btnAuto").onclick = async ()=>{
    console.log("Auto clicked");               // للتأكد
    if(auto) return;
    auto = true; stopFlag=false;
    $("btnAuto").disabled = true; $("btnStop").disabled=false;
    try { await runCycle(); }
    finally { auto=false; $("btnAuto").disabled=false; $("btnStop").disabled=true; }
  };

  $("btnStop").onclick = ()=>{ stopFlag=true; log("STOP requested","log-other"); };

  // --- Kinematics & movement ---
  const base = {x:250, y:340};
  const L1 = 140, L2 = 120;
  const P1 = {x:170, y:280}, P2 = {x:520, y:220}, P3 = {x:600, y:255};

  function ik(x,y){
    const dx=x-base.x, dy=y-base.y;
    const D=(dx*dx+dy*dy-L1*L1-L2*L2)/(2*L1*L2);
    const c2=Math.min(1,Math.max(-1,D)), s2=Math.sqrt(Math.max(0,1-c2*c2));
    const th2=Math.atan2(s2,c2);
    const th1=Math.atan2(dy,dx)-Math.atan2(L2*s2, L1+L2*c2);
    return {th1,th2};
  }
  function setJoints(th1, th2){
    $("link1").setAttribute("transform",`rotate(${th1*180/Math.PI})`);
    $("link2").setAttribute("transform",`translate(${L1},0) rotate(${th2*180/Math.PI})`);
  }
  function getCurrentAngles(){
    let a1=-60*Math.PI/180, a2=40*Math.PI/180;
    const m1=/rotate\(([-\d.]+)\)/.exec($("link1").getAttribute("transform")||"");
    const m2=/rotate\(([-\d.]+)\)/.exec($("link2").getAttribute("transform")||"");
    if(m1) a1=parseFloat(m1[1])*Math.PI/180;
    if(m2) a2=parseFloat(m2[1])*Math.PI/180;
    return {th1:a1, th2:a2};
  }
  function moveToolTo(pt, steps=60, ms=30){   // أبطأ باش تبان الحركة
    return new Promise(async (res)=>{
      const {th1:cur1, th2:cur2}=getCurrentAngles();
      const {th1:t1, th2:t2}=ik(pt.x, pt.y);
      for(let i=1;i<=steps;i++){
        if(stopFlag) break;
        const a1=cur1+(t1-cur1)*i/steps;
        const a2=cur2+(t2-cur2)*i/steps;
        setJoints(a1,a2);
        await sleep(ms);
      }
      res();
    });
  }

  function grip(close){
    // أصابع الماسك
    $("fingerL").setAttribute("x", close? -14 : -16);
    $("fingerR").setAttribute("x", close?  6 :   8);

    if (close){
      // Pick: خُذ اللوحة من P1 → أخفي stack، أظهر carry
      $("panelStack").setAttribute("opacity", 0);
      $("panelCarry").setAttribute("opacity", 1);
    }else{
      // Place: حط اللوحة على الستاند → أخفي carry، أظهر stand
      $("panelCarry").setAttribute("opacity", 0);
      $("panelStand").setAttribute("opacity", 1);
    }
  }

  async function runCycle(){
    log("Auto cycle started","log-other");
    fill("bar_flash",0); fill("bar_test",0);
    setLed("led_flash",""); setLed("led_test",""); setLed("led_ack","");

    // وضع البداية:
    // - اللوحة مرئية فوق P1 (panelStack)
    // - الستاند فاضي (panelStand مخفية)
    // - الماسك فاضي (panelCarry مخفية)
    $("panelStack").setAttribute("opacity", 1);
    $("panelStand").setAttribute("opacity", 0);
    $("panelCarry").setAttribute("opacity", 0);

    // الإشارات في البداية: موش جاهز و Sensor=0
    setRobotAt(0);
    setSensor(0);
    refreshLEDs();

    await moveToolTo(P1);
    grip(true); log("Gripper CLOSE (pick panel)");
    setSensor(0);
    setRobotAt(0);
    refreshLEDs();

    await moveToolTo(P2); log("Move over stand","log-other");
    await moveToolTo(P3); log("Arrived at place","log-other");

    grip(false); log("Gripper OPEN (place panel)");
    setSensor(1);
    setRobotAt(1);
    refreshLEDs();

    setLed("led_flash","busy"); log("Flashing started","log-flash");
    await animateBar("bar_flash",1200);
    setLed("led_flash","on"); log("Flashing done","log-flash");

    setLed("led_test","busy"); log("Testing started","log-test");
    await animateBar("bar_test",1500);
    setLed("led_test","on"); log("Testing done","log-test");

    setLed("led_ack","on"); log("ACK ON → Robot","log-ack");
    await sleep(800);
    setLed("led_ack",""); log("ACK OFF","log-ack");

    // الروبوت يطيّح DO بعد الـACK
    setRobotAt(0);
    // Sensor يبقى 1 لأن اللوحة بقيت على الستاند
    refreshLEDs();
    log("Auto cycle finished","log-other");
  }

  function animateBar(id, duration){
    return new Promise((resolve)=>{
      const start=performance.now();
      (function step(now){
        const p=Math.min(1,(now-start)/duration);
        $(id).style.width=(p*100)+"%";
        if(id==="bar_flash") $("txt_flash").textContent=Math.round(p*100)+"%";
        if(id==="bar_test")  $("txt_test").textContent=Math.round(p*100)+"%";
        if(stopFlag || p>=1) return resolve();
        requestAnimationFrame(step);
      })(start);
    });
  }

  async function processReadyCycle(){
    if (busy) return; busy = true;
    fill("bar_flash",0); fill("bar_test",0);
    setLed("led_flash",""); setLed("led_test",""); setLed("led_ack","");

    setLed("led_flash","busy"); log("Flashing started","log-flash");
    await animateBar("bar_flash",1200);
    setLed("led_flash","on"); log("Flashing done","log-flash");

    setLed("led_test","busy"); log("Testing started","log-test");
    await animateBar("bar_test",1500);
    setLed("led_test","on"); log("Testing done","log-test");

    setLed("led_ack","on"); log("ACK ON → Robot","log-ack");
    await sleep(800);
    setLed("led_ack",""); log("ACK OFF","log-ack");
    busy=false;
  }

  function setRobotAt(v){
    robotAt = v ? 1 : 0;
    $("btnRobot").classList.toggle("active", !!robotAt);
    $("btnRobot").textContent = `RobotAt = ${robotAt}`;
  }
  function setSensor(v){
    sensor = v ? 1 : 0;
    $("btnSensor").classList.toggle("active", !!sensor);
    $("btnSensor").textContent = `Sensor = ${sensor}`;
  }

  // init
  refreshLEDs();
  console.log("Auto button ready:", !!$("btnAuto"));
  log("Ready — use Auto Cycle or manual toggles.");
});

