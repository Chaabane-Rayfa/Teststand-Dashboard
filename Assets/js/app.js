document.addEventListener('DOMContentLoaded', () => {
  /* ---------- State / UI helpers ---------- */
  let robotAt = 0, sensor = 0, busy = false;
  let auto = false;            // running flag
  let stopFlag = false;        // pause request
  let prevReady = false;

  // Cycle tracking
  let stepIdx = 0;             // داخل نفس الدورة (cycle): 0..7
  let cyclesDone = 0;          // عدد الدورات المكتملة
  let currentCycle = 1;        // رقم الدورة الحالية (human-readable)

  // Progress resumable state
  let flashRemain = null;      // ms remaining for flashing
  let testRemain  = null;      // ms remaining for testing

  const FLASH_TOTAL = 1200;    // ms
  const TEST_TOTAL  = 1500;    // ms

  const $ = (id) => document.getElementById(id);
  const setLed = (id, cls) => { $(id).className = "led " + (cls || ""); };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const fill = (id, v) => { $(id).style.width = v + "%"; };

  // ensure counters UI (created if missing)
  ensureCountersUI();

  function log(msg, cls = "log-other") {
    const t = new Date().toLocaleTimeString();
    $("log").innerHTML = `<div class="${cls}">[${t}] ${msg}</div>` + $("log").innerHTML;
  }

  function refreshCountersUI() {
    const cd = $('cyclesDone'), cc = $('currentCycle'), sl = $('stepLabel');
    if (cd) cd.textContent = String(cyclesDone);
    if (cc) cc.textContent = String(currentCycle);
    if (sl) sl.textContent = stepName(stepIdx);
  }

  function stepName(i){
    return [
      "Move → P1 (Pick)",
      "Move → P2 (Over Stand)",
      "Place @P3",
      "Flashing…",
      "Testing…",
      "ACK → Robot",
      "Move → P4 (Store)",
      "Return → P1"
    ][i] || "Idle";
  }

  function refreshLEDs() {
    setLed("led_robot", robotAt ? "on" : "");
    setLed("led_sensor", sensor ? "on" : "");
    const ready = robotAt && sensor;
    setLed("led_ready", ready ? "on" : "");
    // trigger manual ready sequence (unchanged behavior)
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
    $("btnAuto").textContent = stepIdx === 0 ? "Running…" : "Resuming…";
    try { await runCyclesWithResume(); }
    finally {
      auto = false;
      $("btnAuto").disabled = false;
      $("btnStop").disabled = true;
      $("btnAuto").textContent = "Run";
    }
  };

  $("btnStop").onclick = () => {
    if (!auto) return;
    stopFlag = true;
    log("STOP (pause) requested — will hold at a safe point", "log-other");
  };

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
        if (stopFlag) break;                     // allow pause amid motion
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
  }
  function pickFromStack(){ clamp(true);  setPanel("carry", "pick P1"); }
  function placeOnStand(){  clamp(false); setPanel("stand", "place P3"); }
  function pickFromStand(){ clamp(true);  setPanel("carry", "pick P3"); }
  function placeAtP4(){     clamp(false); setPanel("p4",   "place P4"); }

  /* -------- Resumable progress bars -------- */
  function animateBarResumable(idBar, idTxt, totalMs, remainMsRef){
    // remainMsRef: { v: number|null }  (object ref so we can store remaining)
    if (remainMsRef.v == null) remainMsRef.v = totalMs;         // first time
    const startRemain = remainMsRef.v;
    const startedAt = performance.now();

    return new Promise((resolve)=>{
      (function step(now){
        if (stopFlag){
          // compute remaining and stop
          const elapsed = now - startedAt;
          const remain = Math.max(0, startRemain - elapsed);
          remainMsRef.v = remain;
          // keep bar at current progress
          const p = (totalMs - remain) / totalMs;
          $(idBar).style.width = (p*100) + "%";
          if (idTxt) $(idTxt).textContent = Math.round(p*100) + "%";
          return resolve('paused');
        }
        const elapsed = now - startedAt;
        const remain = Math.max(0, startRemain - elapsed);
        const p = (totalMs - remain) / totalMs;
        $(idBar).style.width = (p*100) + "%";
        if (idTxt) $(idTxt).textContent = Math.round(p*100) + "%";

        if (remain <= 0){
          remainMsRef.v = null; // finished
          return resolve('ok');
        }
        requestAnimationFrame(step);
      })(startedAt);
    });
  }

  /* -------- Steps of one cycle (resumable) -------- */
  async function runStep(i){
    switch(i){
      case 0: // Move to P1 & pick
        await moveToolTo(P1);
        if (stopFlag) return 'paused';
        pickFromStack();
        setRobotAt(0); setSensor(0); refreshLEDs();
        return 'ok';

      case 1: // Move to P2
        await moveToolTo(P2);
        if (stopFlag) return 'paused';
        return 'ok';

      case 2: // Move to P3 & place
        await moveToolTo(P3);
        if (stopFlag) return 'paused';
        placeOnStand();
        setSensor(1); setRobotAt(1); refreshLEDs();
        return 'ok';

      case 3: // Flashing
        setLed("led_flash","busy"); log("Flashing started","log-flash");
        const fr = { v: flashRemain };
        {
          const r = await animateBarResumable("bar_flash","txt_flash", FLASH_TOTAL, fr);
          flashRemain = fr.v;
          if (r === 'paused') return 'paused';
        }
        setLed("led_flash","on"); log("Flashing done","log-flash");
        return 'ok';

      case 4: // Testing
        setLed("led_test","busy"); log("Testing started","log-test");
        const tr = { v: testRemain };
        {
          const r = await animateBarResumable("bar_test","txt_test", TEST_TOTAL, tr);
          testRemain = tr.v;
          if (r === 'paused') return 'paused';
        }
        setLed("led_test","on"); log("Testing done","log-test");
        return 'ok';

      case 5: // ACK
        setLed("led_ack","on"); log("ACK ON → Robot","log-ack");
        // make ACK wait resumable-ish: short chunks
        let ackRemain = 600;
        while (ackRemain > 0){
          if (stopFlag) return 'paused';
          const dt = Math.min(50, ackRemain);
          await sleep(dt);
          ackRemain -= dt;
        }
        setLed("led_ack",""); log("ACK OFF","log-ack");
        return 'ok';

      case 6: // Pick from stand → P4
        await moveToolTo(P3);
        if (stopFlag) return 'paused';
        pickFromStand();

        await moveToolTo(P4);
        if (stopFlag) return 'paused';
        placeAtP4();
        return 'ok';

      case 7: // Return to P1, prep next
        await moveToolTo(P1);
        if (stopFlag) return 'paused';
        // prepare for next cycle
        setRobotAt(0); setSensor(0); refreshLEDs();
        // reset process leds for next round
        setLed("led_flash",""); setLed("led_test",""); setLed("led_ack","");
        fill("bar_flash",0); $("txt_flash").textContent = "";
        fill("bar_test",0);  $("txt_test").textContent  = "";
        flashRemain = null; testRemain = null;
        log("Cycle complete — ready for next", "log-ack");
        return 'ok';
    }
    return 'ok';
  }

  async function runCyclesWithResume(){
    log(`Run pressed — Cycle ${currentCycle}, Step ${stepIdx}`, "log-ack");
    refreshCountersUI();

    // IMPORTANT: ما نعملوش Reset للـpanel في بداية كل Cycle، بش نحافظو على الحالة وقت الـPause.
    // لو حاب تعاود من جديد فعلا، اعمل Reset يدوي (تقدر تزيد زر إن حبيت).

    try{
      // loop إلى أن يصير Pause أو يكمل ستبس الدورة (ثم يبدأ اللي بعدها)
      mainLoop:
      while(!stopFlag){
        // نفّذ الستيب الحالي
        const r = await runStep(stepIdx);
        if (r === 'paused') break; // خرج بالـPause، نحافظ على stepIdx كما هو

        // Advance step
        stepIdx++;
        refreshCountersUI();

        if (stepIdx >= 8){
          // دورة اكتملت
          stepIdx = 0;
          cyclesDone += 1;
          currentCycle += 1;
          refreshCountersUI();
          // optional breather
          await sleep(200);
        }
      }
    } finally {
      // انتهينا إمّا بPause أو بخروج آخر
      if (stopFlag){
        log(`Paused @ Step ${stepIdx} (Cycle ${currentCycle}) — press Run to resume`, "log-other");
        $("btnAuto").textContent = "Resume";
      }else{
        log("Stopped", "log-other");
      }
    }
  }

  /* -------- Manual “ready” mini-sequence (unchanged) -------- */
  async function processReadyCycle(){
    if (busy) return; busy = true;
    fill("bar_flash",0); fill("bar_test",0);
    setLed("led_flash",""); setLed("led_test",""); setLed("led_ack","");

    setLed("led_flash","busy"); log("Flashing started","log-flash");
    await animateBarOneShot("bar_flash","txt_flash",1200);
    setLed("led_flash","on"); log("Flashing done","log-flash");

    setLed("led_test","busy"); log("Testing started","log-test");
    await animateBarOneShot("bar_test","txt_test",1500);
    setLed("led_test","on"); log("Testing done","log-test");

    setLed("led_ack","on"); log("ACK ON → Robot","log-ack");
    await sleep(800);
    setLed("led_ack",""); log("ACK OFF","log-ack");
    busy = false;
  }

  function animateBarOneShot(idBar, idTxt, duration){
    return new Promise((resolve)=>{
      const start = performance.now();
      (function step(now){
        const p = Math.min(1, (now - start) / duration);
        $(idBar).style.width = (p*100) + "%";
        if (idTxt) $(idTxt).textContent = Math.round(p*100) + "%";
        if (p >= 1) return resolve();
        requestAnimationFrame(step);
      })(start);
    });
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
  refreshCountersUI();
  log("Ready — press Run to start Auto Cycle with Pause/Resume.");
  console.log("Auto button ready:", !!$("btnAuto"));

  /* -------- utility: inject counters UI if missing -------- */
  function ensureCountersUI(){
    if (!$('cyclesDone') || !$('currentCycle') || !$('stepLabel')){
      // نحطّ badge شابة فوق الـcontrols لو مش موجودة
      const controlsCard = document.querySelector('.card.card--controls') || document.querySelector('.card');
      if (controlsCard){
        const legend = document.createElement('div');
        legend.className = 'legend';
        legend.style.marginBottom = '8px';
        legend.innerHTML = `
          <span class="badge"><strong>Cycles:</strong>&nbsp;<span id="cyclesDone">0</span></span>
          <span class="badge"><strong>Current:</strong>&nbsp;<span id="currentCycle">1</span></span>
          <span class="badge"><strong>Step:</strong>&nbsp;<span id="stepLabel">Idle</span></span>
        `;
        // حطها بعد العنوان لو نلقاه
        const h2 = controlsCard.querySelector('h2');
        if (h2 && h2.nextSibling){
          controlsCard.insertBefore(legend, h2.nextSibling);
        }else{
          controlsCard.prepend(legend);
        }
      }
    }
  }
});
