document.addEventListener('DOMContentLoaded', () => {
  /* ---------- State / UI helpers ---------- */
  let robotAt = 0, sensor = 0, busy = false, auto = false, stopFlag = false;
  let prevReady = false;

  const $ = (id) => document.getElementById(id);
  const setLed = (id, cls) => { $(id).className = "led " + (cls || ""); };
  const log = (msg, cls = "log-other") => {
    const t = new Date().toLocaleTimeString();
    $("log").innerHTML = `<div class="${cls}">[${t}] ${msg}</div>` + $("log").innerHTML;
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const fill = (id, v) => { $(id).style.width = v + "%"; };

  function refreshLEDs() {
    setLed("led_robot", robotAt ? "on" : "");
    setLed("led_sensor", sensor ? "on" : "");
    const ready = robotAt && sensor;
    setLed("led_ready", ready ? "on" : "");
    if (ready && !prevReady && !busy && !auto) processReadyCycle();
    prevReady = ready;
  }

  // --- Buttons ---
  $("btnRobot").onclick = () => { setRobotAt(1 - robotAt); refreshLEDs(); };
  $("btnSensor").onclick = () => { setSensor(1 - sensor); refreshLEDs(); };

  $("btnAuto").onclick = async () => {
    if (auto) return;
    auto = true; stopFlag = false;
    $("btnAuto").disabled = true; $("btnStop").disabled = false;
    try { await runCycle(); }
    finally { auto = false; $("btnAuto").disabled = false; $("btnStop").disabled = true; }
  };

  $("btnStop").onclick = () => { stopFlag = true; log("STOP requested", "log-other"); };

  // --- Kinematics & movement ---
  const base = { x: 400, y: 340 };
  const L1 = 140, L2 = 120;

  const P1 = { x: 550, y: 280 };   // يمين الستاند
  const P2 = { x: 400, y: 240 };   // فوق الستاند
  const P3 = { x: 400, y: 280 };   // على الستاند
  const P4 = { x: 250, y: 280 };   // يسار الستاند

  function ik(x, y) {
    const dx = x - base.x, dy = y - base.y;
    const D = (dx*dx + dy*dy - L1*L1 - L2*L2) / (2*L1*L2);
    const c2 = Math.min(1, Math.max(-1, D)), s2 = Math.sqrt(Math.max(0, 1 - c2*c2));
    const th2 = Math.atan2(s2, c2);
    const th1 = Math.atan2(dy, dx) - Math.atan2(L2*s2, L1 + L2*c2);
    return { th1, th2 };
  }
  function setJoints(th1, th2) {
    $("link1").setAttribute("transform", `rotate(${th1*180/Math.PI})`);
    $("link2").setAttribute("transform", `translate(${L1},0) rotate(${th2*180/Math.PI})`);
  }
  function getCurrentAngles() {
    let a1 = -60*Math.PI/180, a2 = 40*Math.PI/180;
    const m1 = /rotate\(([-\d.]+)\)/.exec($("link1").getAttribute("transform") || "");
    const m2 = /rotate\(([-\d.]+)\)/.exec($("link2").getAttribute("transform") || "");
    if (m1) a1 = parseFloat(m1[1]) * Math.PI/180;
    if (m2) a2 = parseFloat(m2[1]) * Math.PI/180;
    return { th1: a1, th2: a2 };
  }
  function moveToolTo(pt, steps = 60, ms = 30) {
    return new Promise(async (res) => {
      const { th1: cur1, th2: cur2 } = getCurrentAngles();
      const { th1: t1, th2: t2 } = ik(pt.x, pt.y);
      for (let i = 1; i <= steps; i++) {
        if (stopFlag) break;
        const a1 = cur1 + (t1 - cur1) * i / steps;
        const a2 = cur2 + (t2 - cur2) * i / steps;
        setJoints(a1, a2);
        await sleep(ms);
      }
      res();
    });
  }

  /* -------- Panel state machine -------- */
  // "stack" | "carry" | "stand" | "p4"
  let panelLoc = "stack";
  const show = (id, on) => $(id).setAttribute("opacity", on ? 1 : 0);

  function renderPanelVisibility() {
    show("panelStack", panelLoc === "stack");
    show("panelCarry", panelLoc === "carry");
    show("panelStand", panelLoc === "stand");
    show("panelP4",    panelLoc === "p4");
  }
  const clamp = (close) => {
    $("fingerL").setAttribute("x", close ? -14 : -16);
    $("fingerR").setAttribute("x", close ?   6 :   8);
  };
  function setPanel(loc, note="") {
    panelLoc = loc; renderPanelVisibility();
    log(`PANEL -> ${loc} ${note ? "(" + note + ")" : ""}`);
    console.log("PANEL ->", loc, note);
  }
  function pickFromStack(){ clamp(true);  setPanel("carry", "pick P1"); }
  function placeOnStand(){  clamp(false); setPanel("stand", "place P3"); }
  function pickFromStand(){ clamp(true);  setPanel("carry", "pick P3"); }
  function placeAtP4(){     clamp(false); setPanel("p4",   "place P4"); }

  /* -------- Auto cycle (50 loops) -------- */
  async function runCycle() {
    for (let i = 0; i < 50; i++) {
      if (stopFlag) break;
      log(`Cycle ${i+1} started`, "log-other");

      // Reset this cycle (keep P4 history)
      setPanel("stack", "cycle start");
      setRobotAt(0); setSensor(0); refreshLEDs();

      // Pick from P1
      await moveToolTo(P1);
      pickFromStack();

      // Move over stand & place
      await moveToolTo(P2);
      await moveToolTo(P3);
      placeOnStand();
      setSensor(1); setRobotAt(1); refreshLEDs();

      // Flash + Test
      setLed("led_flash","busy"); log("Flashing started","log-flash");
      await animateBar("bar_flash", 1200);
      setLed("led_flash","on"); log("Flashing done","log-flash");

      setLed("led_test","busy"); log("Testing started","log-test");
      await animateBar("bar_test", 1500);
      setLed("led_test","on"); log("Testing done","log-test");

      // ACK
      setLed("led_ack","on"); log("ACK ON → Robot","log-ack");
      await sleep(600);
      setLed("led_ack",""); log("ACK OFF","log-ack");

      // Pick from stand → place at P4
      await moveToolTo(P3);
      pickFromStand(); // hides panelStand, shows carry

      await moveToolTo(P4);
      placeAtP4();     // shows panelP4, ensures stand hidden

      // Prepare next cycle
      setRobotAt(0); setSensor(0); refreshLEDs();
      log(`Cycle ${i+1} finished`, "log-other");
      await sleep(300);
    }
    log("All cycles finished or stopped", "log-other");
  }

  /* -------- Other helpers -------- */
  function animateBar(id, duration){
    return new Promise((resolve)=>{
      const start = performance.now();
      (function step(now){
        const p = Math.min(1, (now - start) / duration);
        $(id).style.width = (p*100) + "%";
        if (id === "bar_flash") $("txt_flash").textContent = Math.round(p*100) + "%";
        if (id === "bar_test")  $("txt_test").textContent  = Math.round(p*100) + "%";
        if (stopFlag || p >= 1) return resolve();
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
    busy = false;
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
  renderPanelVisibility();
  refreshLEDs();
  console.log("Auto button ready:", !!$("btnAuto"));
  log("Ready — use Auto Cycle or manual toggles.");
});
