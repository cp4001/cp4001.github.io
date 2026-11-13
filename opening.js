/* Local Three.js scene: one structural grid drives the plan and the building. */
(() => {
  const opening = document.getElementById('opening');
  const skip = document.getElementById('skipOpening');
  const replay = document.getElementById('replayOpening');
  const stage = document.getElementById('openingScene');
  const phaseLabel = document.getElementById('openingPhase');
  const progress = document.getElementById('openingProgress');
  const controls = document.getElementById('openingControls');
  const hint = document.getElementById('openingHint');
  const zoomIn = document.getElementById('zoomInOpening');
  const zoomOut = document.getElementById('zoomOutOpening');
  const reset = document.getElementById('resetOpening');
  const steps = [...document.querySelectorAll('.opening-steps span')];
  const page = [...document.querySelectorAll('body > nav, body > header, body > main')];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let renderer, scene, camera, frame = 0, start = 0, previous = 0, active = false, returnFocus, hiddenAt = null;
  let floors, finishes, systems, board, blueprint, drawPlan, grid, composer, occlusion;
  let interactive = false;
  const orbit = { azimuth: .96, elevation: .1, scale: 1 };
  const pointers = new Map(), transparentBatches = [];
  const clamp = value => Math.max(0, Math.min(1, value));
  const ease = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
  const duration = 10400;

  function close() {
    active = false;
    cancelAnimationFrame(frame);
    frame = 0;
    interactive = false;
    for (const id of pointers.keys()) if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
    pointers.clear();
    stage.classList.remove('is-dragging');
    stage.tabIndex = -1;
    opening.classList.remove('is-open');
    opening.inert = true;
    opening.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('opening-active');
    page.forEach(node => { node.inert = false; });
    if (opening.contains(document.activeElement)) {
      (returnFocus || document.querySelector('.brand')).focus({ preventScroll: true });
    }
  }
  skip.addEventListener('click', close);
  opening.addEventListener('keydown', event => {
    if (event.key === 'Escape') { close(); return; }
    if (event.key === 'Tab') {
      const targets = [skip, ...(interactive ? [stage, zoomOut, zoomIn, reset].filter(node => !node.disabled) : [])];
      const index = targets.indexOf(document.activeElement);
      targets[(index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length].focus({ preventScroll: true });
      event.preventDefault();
    }
    if (event.target !== stage || !interactive) return;
    const keys = { ArrowLeft: [-.12, 0], ArrowRight: [.12, 0], ArrowUp: [0, .08], ArrowDown: [0, -.08] };
    if (keys[event.key]) rotate(...keys[event.key]);
    else if (event.key === '+' || event.key === '=') zoom(.85);
    else if (event.key === '-') zoom(1.15);
    else if (event.key === 'Home') resetView();
    else return;
    event.preventDefault();
  });

  function rotate(horizontal, vertical) {
    orbit.azimuth += horizontal;
    orbit.elevation = Math.max(.04, Math.min(1.35, orbit.elevation + vertical));
    requestView();
  }
  function zoom(factor) {
    orbit.scale = Math.max(.6, Math.min(1.65, orbit.scale * factor));
    zoomIn.setAttribute('aria-disabled', String(orbit.scale <= .6));
    zoomOut.setAttribute('aria-disabled', String(orbit.scale >= 1.65));
    requestView();
  }
  function resetView() {
    Object.assign(orbit, { azimuth: .96, elevation: .1, scale: 1 });
    zoomIn.setAttribute('aria-disabled', 'false');
    zoomOut.setAttribute('aria-disabled', 'false');
    requestView();
  }
  function requestView() {
    if (!active || !interactive || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!active || !interactive) return;
      placeCamera(orbit.azimuth, orbit.elevation, viewDistance() * orbit.scale, 8.1);
      drawScene();
    });
  }
  function explore() {
    interactive = true;
    opening.dataset.interactive = 'true';
    controls.hidden = hint.hidden = false;
    stage.tabIndex = 0;
    phaseLabel.textContent = '완성된 건축물을 자유롭게 살펴보세요.';
    renderer.shadowMap.autoUpdate = false;
    resize();
    resetView();
  }
  zoomIn.addEventListener('click', () => zoom(.85));
  zoomOut.addEventListener('click', () => zoom(1.15));
  reset.addEventListener('click', resetView);
  stage.addEventListener('pointerdown', event => {
    if (!active || !interactive || event.button !== 0 || pointers.size >= 2) return;
    event.preventDefault();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    stage.setPointerCapture(event.pointerId);
    stage.classList.add('is-dragging');
    stage.focus({ preventScroll: true });
  });
  stage.addEventListener('pointermove', event => {
    const before = pointers.get(event.pointerId);
    if (!before || !interactive) return;
    const oldPoints = [...pointers.values()];
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) rotate(-(event.clientX - before.x) * .008, (event.clientY - before.y) * .006);
    else {
      const points = [...pointers.values()];
      const oldDistance = Math.hypot(oldPoints[0].x - oldPoints[1].x, oldPoints[0].y - oldPoints[1].y);
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      if (oldDistance > 0 && distance > 0) zoom(oldDistance / distance);
    }
  });
  function endPointer(event) {
    pointers.delete(event.pointerId);
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    if (!pointers.size) stage.classList.remove('is-dragging');
  }
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => stage.addEventListener(type, endPointer));
  stage.addEventListener('wheel', event => {
    if (!active || !interactive) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1);
    zoom(Math.exp(Math.max(-300, Math.min(300, delta)) * .001));
  }, { passive: false });

  function setup() {
    const T = window.THREE;
    renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFShadowMap;
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.04;
    renderer.domElement.setAttribute('aria-hidden', 'true');
    renderer.domElement.addEventListener('webglcontextlost', event => { event.preventDefault(); close(); });
    stage.appendChild(renderer.domElement);
    scene = new T.Scene();
    scene.background = new T.Color(0xf1dfc9);
    scene.fog = new T.Fog(0xf1dfc9, 105, 205);
    camera = new T.PerspectiveCamera(18, 1, .5, 600);
    scene.add(new T.HemisphereLight(0xfff7e7, 0x8b8270, .65));
    const sun = new T.DirectionalLight(0xfff4e7, 2.5);
    sun.position.set(-22, 32, 35);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -35, right: 35, top: 35, bottom: -35, near: 1, far: 110 });
    sun.shadow.bias = -.0003;
    sun.shadow.normalBias = .018;
    sun.shadow.radius = 5;
    scene.add(sun);
    const rim = new T.DirectionalLight(0xf1ebdb, .75);
    rim.position.set(28, 18, 8);
    rim.castShadow = true;
    rim.shadow.mapSize.set(1024, 1024);
    Object.assign(rim.shadow.camera, { left: -28, right: 28, top: 28, bottom: -28, near: 1, far: 90 });
    rim.shadow.normalBias = .025; rim.shadow.bias = -.0002; rim.shadow.radius = 5;
    scene.add(rim);

    // Local procedural materials keep file:// playback independent of network assets.
    let seed = 41;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    function surface(kind) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
      const c = canvas.getContext('2d');
      c.fillStyle = kind === 'wood' ? '#c8a87c' : kind === 'gravel' ? '#d2cec0' : '#e5ddd5';
      c.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 15000; i++) {
        const v = Math.floor(70 + random() * 110);
        c.fillStyle = `rgba(${v},${v - 8},${v - 17},${kind === 'gravel' ? .24 : .21})`;
        const x = random() * 512, y = random() * 512;
        c.fillRect(x, y, kind === 'wood' ? 1 : 1 + random() * 3, kind === 'wood' ? 10 + random() * 80 : 1 + random() * 2);
      }
      if (kind === 'stone') {
        for (let y = 0; y < 512; y += 4) {
          c.fillStyle = `rgba(90,78,57,${random() * .045})`; c.fillRect(0, y, 512, 1 + random() * 3);
        }
      }
      const map = new T.CanvasTexture(canvas);
      map.colorSpace = T.SRGBColorSpace;
      map.wrapS = map.wrapT = T.RepeatWrapping;
      map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      return map;
    }
    const stoneMap = surface('stone'), woodMap = surface('wood'), gravelMap = surface('gravel');
    const concrete = new T.MeshStandardMaterial({ color: 0xcdc7bf, roughness: .86, map: stoneMap, bumpMap: stoneMap, bumpScale: .035, envMapIntensity: .15 });
    const stone = new T.MeshStandardMaterial({ color: 0xddd0c5, map: stoneMap, bumpMap: stoneMap, bumpScale: .045, roughness: .78, envMapIntensity: .2 });
    const edge = new T.MeshStandardMaterial({ color: 0xd5d0c3, roughness: .58, envMapIntensity: .45 });
    const metal = new T.MeshStandardMaterial({ color: 0x626958, metalness: .4, roughness: .42, envMapIntensity: .35 });
    const bronze = new T.MeshStandardMaterial({ color: 0x8d7356, metalness: .7, roughness: .34 });
    const timber = new T.MeshStandardMaterial({ color: 0xd6bc96, map: woodMap, bumpMap: woodMap, bumpScale: .015, roughness: .7 });
    const core = new T.MeshStandardMaterial({ color: 0x86847b, roughness: .85 });
    const glass = new T.MeshPhysicalMaterial({ color: 0x8f9a81, metalness: .15, roughness: .13, transparent: true, opacity: .46, depthWrite: false, clearcoat: 1, envMapIntensity: .7 });
    const glassShade = glass.clone(); glassShade.color.set(0x899686); glassShade.opacity = .48;
    const warm = new T.MeshStandardMaterial({ color: 0xffdeb1, emissive: 0xffbf74, emissiveIntensity: 1.2 });
    const leaf = new T.MeshStandardMaterial({ color: 0xffffff, roughness: .92, envMapIntensity: .2 });
    const soil = new T.MeshStandardMaterial({ color: 0x343b29, roughness: 1 });
    const fabric = new T.MeshStandardMaterial({ color: 0x747b63, roughness: 1, envMapIntensity: .2 });
    const gravel = new T.MeshStandardMaterial({ color: 0xb4b1a4, map: gravelMap, bumpMap: gravelMap, bumpScale: .065, roughness: 1 });

    // A filtered sky and distant urban silhouettes create real angle-dependent reflections.
    const skyCanvas = document.createElement('canvas'); skyCanvas.width = 1024; skyCanvas.height = 512;
    const sky = skyCanvas.getContext('2d');
    const skyGradient = sky.createLinearGradient(0, 0, 0, 512);
    [[0, '#c4c8be'], [.32, '#eee9df'], [.5, '#fff6e5'], [.55, '#c5c4b5'], [1, '#7d8272']].forEach(([p, c]) => skyGradient.addColorStop(p, c));
    sky.fillStyle = skyGradient; sky.fillRect(0, 0, 1024, 512);
    for (let i = 0; i < 36; i++) {
      const x = i * 31, h = 12 + random() * 60;
      sky.fillStyle = i % 3 ? '#687c80' : '#879899'; sky.fillRect(x, 264 - h, 14 + random() * 22, h + 25);
    }
    for (let i = 0; i < 12; i++) {
      sky.fillStyle = 'rgba(255,255,250,.18)'; sky.beginPath();
      sky.ellipse(random() * 1024, 80 + random() * 100, 40 + random() * 90, 5 + random() * 12, -.1, 0, Math.PI * 2); sky.fill();
    }
    const skyTexture = new T.CanvasTexture(skyCanvas);
    skyTexture.mapping = T.EquirectangularReflectionMapping; skyTexture.colorSpace = T.SRGBColorSpace;
    const pmrem = new T.PMREMGenerator(renderer);
    scene.environment = pmrem.fromEquirectangular(skyTexture).texture;
    skyTexture.dispose(); pmrem.dispose();
    const boxGeometry = new T.BoxGeometry(1, 1, 1), bevels = new Map();
    function box(parent, x, y, z, w, h, d, material, shadow = true) {
      let geometry = boxGeometry;
      if (window.ArchPost && Math.min(w, h, d) > .065) {
        const radius = Math.min(.025, w * .12, h * .12, d * .12);
        const key = `${w}/${h}/${d}`;
        if (!bevels.has(key)) bevels.set(key, new window.ArchPost.RoundedBoxGeometry(w, h, d, 2, radius));
        geometry = bevels.get(key);
      }
      const mesh = new T.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      if (geometry === boxGeometry) mesh.scale.set(w, h, d);
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    }
    const ground = new T.Mesh(new T.PlaneGeometry(2000, 2000), new T.MeshStandardMaterial({ color: 0xe4dccb, roughness: 1, envMapIntensity: .18 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -.16;
    scene.add(ground);
    const groundShadow = new T.Mesh(ground.geometry, new T.ShadowMaterial({ opacity: .17 }));
    groundShadow.rotation.x = -Math.PI / 2; groundShadow.position.y = -.155;
    groundShadow.receiveShadow = true; scene.add(groundShadow);
    grid = new T.GridHelper(120, 60, 0xaaa99b, 0xbcb8a9);
    grid.position.y = -.15;
    grid.material.transparent = true;
    grid.material.opacity = .025;
    scene.add(grid);

    // Plan and model share the same 8 m front bays and exposed side columns.
    const sheet = document.createElement('canvas');
    sheet.width = 1680;
    sheet.height = 1280;
    const ctx = sheet.getContext('2d');
    blueprint = new T.CanvasTexture(sheet);
    blueprint.colorSpace = T.SRGBColorSpace;
    blueprint.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const paper = new T.MeshStandardMaterial({ map: blueprint, roughness: .95, transparent: true });
    board = new T.Mesh(new T.PlaneGeometry(42, 32), paper);
    board.rotation.x = -Math.PI / 2;
    board.position.y = -.08;
    board.receiveShadow = true;
    scene.add(board);
    const px = x => (x + 21) * 40;
    const pz = z => (z + 16) * 40;
    drawPlan = t => {
      ctx.fillStyle = '#e3daca'; ctx.fillRect(0, 0, sheet.width, sheet.height);
      ctx.strokeStyle = '#e3ddcf'; ctx.lineWidth = 1;
      for (let x = 40; x < 1680; x += 40) { ctx.beginPath(); ctx.moveTo(x, 40); ctx.lineTo(x, 1240); ctx.stroke(); }
      for (let z = 40; z < 1280; z += 40) { ctx.beginPath(); ctx.moveTo(40, z); ctx.lineTo(1640, z); ctx.stroke(); }
      ctx.strokeStyle = '#8d9483'; ctx.lineWidth = 2; ctx.strokeRect(30, 30, 1620, 1220);
      function line(x1, z1, x2, z2, delay = 0, width = 3) {
        const f = ease((t - delay) / .65);
        ctx.lineWidth = width;
        ctx.beginPath(); ctx.moveTo(px(x1), pz(z1)); ctx.lineTo(px(x1 + (x2 - x1) * f), pz(z1 + (z2 - z1) * f)); ctx.stroke();
      }
      ctx.strokeStyle = '#626956';
      for (let x = -12; x <= 12; x += 8) line(x, -11, x, 11, .1 + (x + 12) * .015, 2);
      for (let z = -8; z <= 8; z += 8) line(-15, z, 15, z, .15 + (z + 8) * .02, 2);
      line(-12, -8, 12, -8, .3, 6); line(12, -8, 12, 8, .4, 6);
      line(12, 8, -12, 8, .5, 6); line(-12, 8, -12, -8, .6, 6);
      if (t > .6) {
        ctx.globalAlpha = ease((t - .6) / .65);
        ctx.fillStyle = '#68745f';
        for (let x = -12; x < 12; x += 8) for (let z = -8; z <= 8; z += 8) ctx.fillRect(px(x - .26), pz(z - .26), 21, 21);
        ctx.lineWidth = 4; ctx.strokeRect(px(-3.25), pz(-6.5), 148, 180);
        for (let z = -5.8; z < -2; z += .3) {
          line(-3, z, -1.65, z, 0, 1); line(-1.4, z, -.05, z, 0, 1);
        }
        for (const x of [-8.5, -3.8, 1.5]) for (const z of [4.7, -3.5]) {
          ctx.lineWidth = 1; ctx.strokeRect(px(x - 1.1), pz(z - .45), 88, 36);
          ctx.strokeRect(px(x - .26), pz(z - 1.2), 21, 20);
        }
        for (const x of [-8.5, 2]) line(x - 2.35, -1.2, x + 2.35, -1.2, 0, 3);
        for (let x = -11.25; x < 12; x += 1.5) line(x, 7.7, x, 8.1, 0, 2);
        for (const z of [-8, -8 / 3, 8 / 3, 8]) ctx.fillRect(px(11.74), pz(z - .26), 21, 21);
        ctx.setLineDash([7, 5]); line(10.55, -7, 10.55, 7, 0, 2); ctx.setLineDash([]);
        ctx.font = '22px monospace'; ctx.textAlign = 'center';
        for (let x = -12; x <= 12; x += 8) {
          ctx.beginPath(); ctx.arc(px(x), pz(-12), 18, 0, Math.PI * 2); ctx.stroke();
          ctx.fillText(String((x + 12) / 8 + 1), px(x), pz(-12) + 7);
          if (x < 12) ctx.fillText('8,000', px(x + 4), pz(10.5));
        }
        ctx.fillText('GROUND FLOOR / STRUCTURAL GRID', 840, 1175);
        ctx.strokeStyle = '#8e8979'; ctx.lineWidth = 1;
        for (const x of [-17.5, -13.5, -9.5, -5.5, -1.5, 2.5, 6.5, 10.5, 14.5]) {
          for (const z of [-14.2, 12]) {
            ctx.strokeRect(px(x), pz(z), 138, 88);
            ctx.strokeRect(px(x + .1), pz(z + .1), 130, 80);
            ctx.strokeRect(px(x + .8), pz(z + .7), 40, 18);
            ctx.strokeRect(px(x + .9), pz(z + 1.25), 14, 14);
            ctx.beginPath(); ctx.arc(px(x + 2.5), pz(z + 2.1), 26, Math.PI, Math.PI * 1.5); ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      }
      blueprint.needsUpdate = true;
    };

    floors = [];
    finishes = [];
    systems = [];
    const heights = 3.7, levels = 4, roofY = heights * levels;
    const duct = new T.MeshStandardMaterial({ color: 0xa0aa8c, roughness: .55, metalness: .18, envMapIntensity: .3 });
    const copper = new T.MeshStandardMaterial({ color: 0xbf8054, roughness: .3, metalness: .4, envMapIntensity: .6 });
    const screen = new T.MeshStandardMaterial({ color: 0x606b59, roughness: .55, metalness: .3 });
    const white = new T.MeshStandardMaterial({ color: 0xcac5b8, roughness: .8, envMapIntensity: .18 });
    const plaster = new T.MeshStandardMaterial({ color: 0xb6b09e, roughness: .93, envMapIntensity: .14 });
    const pipeGeometry = new T.CylinderGeometry(1, 1, 1, 12);
    function cylinder(parent, x, y, z, radius, height, material) {
      const mesh = new T.Mesh(pipeGeometry, material);
      mesh.position.set(x, y, z); mesh.scale.set(radius, height, radius);
      mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh);
      return mesh;
    }
    // Rounded elbows keep the exposed services readable from every angle.
    function pipe(parent, points, radius = .065) {
      const vertices = points.map(point => new T.Vector3(...point));
      const path = new T.CurvePath();
      let start = vertices[0];
      for (let i = 1; i < vertices.length - 1; i++) {
        const p = vertices[i], next = vertices[i + 1];
        const r = Math.min(.3, p.distanceTo(start) * .35, p.distanceTo(next) * .35);
        const a = p.clone().add(start.clone().sub(p).normalize().multiplyScalar(r));
        const b = p.clone().add(next.clone().sub(p).normalize().multiplyScalar(r));
        path.add(new T.LineCurve3(start, a));
        path.add(new T.QuadraticBezierCurve3(a, p, b));
        start = b;
      }
      path.add(new T.LineCurve3(start, vertices[vertices.length - 1]));
      const mesh = new T.Mesh(new T.TubeGeometry(path, points.length * 14, radius, 8, false), copper);
      mesh.castShadow = true; parent.add(mesh);
    }
    const slabOutline = new T.Shape();
    slabOutline.moveTo(-12.35, -8.35); slabOutline.lineTo(12.35, -8.35);
    slabOutline.lineTo(12.35, 8.35); slabOutline.lineTo(-12.35, 8.35); slabOutline.closePath();
    const stairOpening = new T.Path();
    stairOpening.moveTo(-3.1, 2.1); stairOpening.lineTo(-3.1, 6.4);
    stairOpening.lineTo(.1, 6.4); stairOpening.lineTo(.1, 2.1); stairOpening.closePath();
    slabOutline.holes.push(stairOpening);
    const slabGeometry = new T.ExtrudeGeometry(slabOutline, { depth: .26, bevelEnabled: false });
    slabGeometry.rotateX(-Math.PI / 2);

    function desk(parent, x, z, angle = 0) {
      const furniture = new T.Group(); furniture.position.set(x, .3, z); furniture.rotation.y = angle; parent.add(furniture);
      box(furniture, 0, .83, 0, 2.2, .075, .9, timber);
      for (const dx of [-.94, .94]) {
        box(furniture, dx, .43, 0, .045, .78, .7, white);
        box(furniture, dx, .06, 0, .32, .035, .75, white);
      }
      box(furniture, 0, 1.18, .12, .7, .43, .04, metal);
      box(furniture, 0, .95, .12, .045, .22, .045, metal);
      box(furniture, 0, .88, .12, .3, .02, .2, metal);
      box(furniture, -.06, .88, -.19, .5, .025, .18, core);
      box(furniture, .73, .88, -.1, .3, .02, .4, white, false);
      box(furniture, 0, .5, -1, .52, .1, .5, fabric);
      box(furniture, 0, .85, -1.22, .52, .62, .075, fabric);
      for (const side of [-1, 1]) {
        box(furniture, side * .31, .68, -1, .045, .04, .4, metal);
        box(furniture, side * .31, .57, -1.12, .03, .2, .03, metal);
      }
      cylinder(furniture, 0, .27, -1, .035, .4, metal);
      for (let i = 0; i < 5; i++) {
        const leg = box(furniture, 0, .08, -1, .035, .035, .65, metal);
        leg.rotation.y = i * Math.PI / 5;
      }
    }

    for (let level = 0; level < levels; level++) {
      const baseY = level * heights;
      const structure = new T.Group(); structure.position.y = baseY; scene.add(structure);
      const columns = new T.Group(); structure.add(columns);
      for (let x = -12; x < 12; x += 8) for (const z of [-8, 0, 8]) box(columns, x, heights / 2, z, .64, heights, .64, concrete);
      for (const z of [-8, -8 / 3, 8 / 3, 8]) box(columns, 12, heights / 2, z, .64, heights, .64, concrete);
      box(columns, -3.25, heights / 2, -4.25, .22, heights, 4.5, concrete);
      box(columns, -1.5, heights / 2, -6.5, 3.7, heights, .22, concrete);
      // Two flights and an actual opening connect consecutive floor plates.
      for (let step = 0; step < 11; step++) {
        box(columns, -2.35, .09 + step * .168, -2.25 - step * .29, 1.35, .15, .32, edge);
        box(columns, -.75, 1.94 + step * .168, -5.15 + step * .29, 1.35, .15, .32, edge);
      }
      box(columns, -1.5, 1.85, -5.75, 3.1, .17, 1.15, concrete);
      const deck = new T.Group(); deck.position.y = heights; structure.add(deck);
      const slab = new T.Mesh(slabGeometry, concrete); slab.castShadow = slab.receiveShadow = true; deck.add(slab);
      for (const z of [-8, 0, 8]) box(deck, 0, -.18, z, 24.5, .36, .5, concrete);
      for (let x = -12; x <= 12; x += 8) box(deck, x, -.18, 0, .64, .36, 16.5, concrete);
      floors.push({ columns, deck });

      const skin = new T.Group(); skin.position.y = baseY; scene.add(skin); finishes.push(skin);
      // Limestone frames, fine mullions and oak fins follow the reference facade.
      for (let x = -12; x <= 12; x += 8) {
        for (let panel = 0; panel < 4; panel++) box(skin, x, .47 + panel * .86, 8.25, 1.05, .854, .85, stone);
      }
      for (let x = -11.25; x < 12; x += 1.5) {
        box(skin, x, heights - .07, 8.25, 1.494, .6, .9, stone);
        box(skin, x, .23, 8.25, 1.494, .27, .9, stone);
        box(skin, x, 1.92, 7.85, 1.43, 3.0, .035, glass, false);
        box(skin, x - .75, 1.92, 7.91, .055, 3.06, .1, metal);
        box(skin, x, 2.92, 7.91, 1.5, .045, .11, metal);
        box(skin, x, .44, 7.91, 1.5, .055, .11, metal);
        box(skin, x, 1.92, -7.9, 1.43, 3.0, .035, glassShade, false);
        box(skin, x - .75, 1.92, -7.95, .055, 3.06, .1, metal);
      }
      for (const x of [-9.7, -1.7, 6.3]) for (let fin = 0; fin < 5; fin++) {
        box(skin, x + fin * .3, 1.95, 8.25, .11, 3.0, .62, timber);
      }
      for (let z = -7.25; z < 8; z += 1.5) {
        box(skin, -11.9, 1.92, z, .035, 3.0, 1.43, glass, false);
        box(skin, -11.95, 1.92, z - .75, .1, 3.06, .055, metal);
        box(skin, -12.15, heights - .07, z, .65, .54, 1.48, stone);
      }
      for (const z of [-8, 0, 8]) box(skin, -12.15, 1.85, z, .65, 3.7, .8, stone);
      box(skin, 0, heights - .07, -8.15, 24.7, .54, .6, stone);
      // The east cutaway exposes structure, workspaces and building services.
      const floorFinish = new T.Mesh(slabGeometry, white);
      floorFinish.position.y = .27; floorFinish.scale.y = .08; floorFinish.receiveShadow = true; skin.add(floorFinish);
      box(skin, 11.9, 1.85, -6.95, .16, 3.42, 1.65, core);
      for (const x of [-8.5, -3.8, 1.5]) for (const z of [4.7, -3.5]) desk(skin, x, z);
      for (const z of [1.2, 5.5, ...(level > 0 ? [-3.5] : [])]) desk(skin, 10.4, z, -Math.PI / 2);
      if (level > 0) for (const z of [-4.2, .8, 5.3]) desk(skin, 6.8, z, Math.PI / 2);
      box(skin, -7, 1.8, -7.65, 9.3, 3.2, .1, white);
      for (const z of [-5.8, -.7, 4.5]) box(skin, 4.15, 1.95, z, .14, 3.3, 3.5, plaster);
      box(skin, 4.15, 3.36, 0, .14, .5, 15.5, plaster);
      box(skin, 8.05, 1.95, -7.7, 7.4, 3.3, .12, plaster);
      for (const z of [-5.2, 3.8]) {
        box(skin, 4.55, .9, z, .6, 1.2, 2.6, white);
        for (const dz of [-.85, 0, .85]) box(skin, 4.87, .9, z + dz, .025, .025, .22, metal);
      }
      for (const x of [-8.5, 2]) {
        box(skin, x, 1.67, -1.2, 4.7, 2.7, .035, glass, false);
        box(skin, x, 3.02, -1.2, 4.7, .045, .08, metal);
        for (const dx of [-2.35, 0, 2.35]) box(skin, x + dx, 1.67, -1.2, .04, 2.7, .08, metal);
      }
      box(skin, -5.4, .94, -6.5, 3.1, 1.35, .68, white);
      for (let x = -6.75; x < -4; x += .55) box(skin, x, .94, -6.14, .015, 1.25, .02, bronze);
      for (const x of [-8, 1, 7]) for (const z of [-3, 4]) {
        box(skin, x, 3.06, z, 2.3, .06, .13, white);
        box(skin, x, 3.02, z, 2.15, .02, .09, warm, false);
        for (const dx of [-.8, .8]) box(skin, x + dx, 3.28, z, .012, .4, .012, metal);
      }

      const services = new T.Group(); services.position.set(12.7, baseY - .25, 0); scene.add(services);
      systems.push({ group: services, axis: 'x', delay: level * .35 });
      box(services, -1.45, 2.91, 4.7, 1.05, .58, 5.2, duct);
      box(services, -1.45, 3.11, -2.7, 1.05, .58, 9.2, duct);
      const offset = box(services, -1.45, 3.01, 1.9, 1.05, .58, .65, duct);
      offset.rotation.x = -.36;
      for (let z = -7; z <= 7; z += 1.45) {
        box(services, -1.45, 2.97, z, 1.1, .5, .035, duct);
        for (const x of [-2.09, -.81]) box(services, x, 3.22, z, .018, .65, .018, metal);
        box(services, -1.45, 2.71, z, 1.34, .035, .08, metal);
      }
      for (const z of [-4.6, 2.8]) {
        box(services, -10.9, 2.95, z, 17.5, .3, .6, duct);
        for (let x = -18.7; x < -2; x += 2) box(services, x, 2.95, z, .04, .35, .66, screen);
        for (const x of [-17.7, -11.7, -5.7]) {
          box(services, x, 2.7, z + .8, .4, .2, 1.5, duct);
          box(services, x, 2.55, z + 1.5, .72, .08, .62, white);
          for (let slit = 0; slit < 4; slit++) box(services, x, 2.5, z + 1.3 + slit * .12, .56, .015, .025, metal, false);
        }
      }
      for (const z of [-5, 0, 5]) {
        box(services, -.3, 3.37, z, .06, .42, .055, metal);
        box(services, -.3, 3.14, z, .75, .055, .1, metal);
      }
      for (let run = 0; run < 3; run++) {
        const x = -.25 - run * .18, y = 3.23 - run * .09;
        pipe(services, [[-.05 - run * .23, y - .3, -6.4], [-.05 - run * .23, y, -6.4], [x, y, -6.4], [x, y, 7.1], [-3.3, y, 7.1]]);
        for (const z of [-4.6, 2.8]) pipe(services, [[x, y, z + .6], [-20, y, z + .6]], .045);
      }
    }

    const site = new T.Group(); scene.add(site); finishes.push(site);
    box(site, 0, .04, 0, 25.5, .3, 17.5, concrete);
    for (let x = -13.5; x < 13.5; x += 1.5) for (let z = 8.7; z < 10.3; z += .8) box(site, x, .1, z, 1.47, .24, .77, stone, false);
    for (let step = 0; step < 4; step++) box(site, 3, -.05 + step * .06, 11.35 - step * .42, 11, .12 + step * .12, .44, stone);
    box(site, 3, .85, 4.7, 3.6, 1.1, .85, stone);
    box(site, 3, .32, 5.14, 3.5, .04, .035, warm, false);
    for (const x of [2.25, 3.75]) box(site, x, 1.7, 8.02, .035, .65, .1, bronze);
    for (const x of [5.9, 8.5]) {
      box(site, x, .65, 6.8, 1.05, .32, .95, fabric);
      box(site, x, 1.04, 6.45, 1.05, .65, .2, fabric);
      for (const side of [-.45, .45]) box(site, x + side, .88, 6.8, .15, .32, 1, fabric);
    }
    cylinder(site, 7.2, .77, 7, .55, .08, timber);
    cylinder(site, 7.2, .51, 7, .045, .5, bronze);
    cylinder(site, 5.1, 1.05, 6.4, .024, 1.5, bronze);
    const lamp = new T.Mesh(new T.SphereGeometry(.23, 20, 12), warm);
    lamp.position.set(5.1, 1.85, 6.4); site.add(lamp);

    const twigGeometry = new T.CylinderGeometry(.65, 1, 1, 7);
    const foliageGeometry = new T.SphereGeometry(1, 5, 4);
    function branch(parent, from, to, radius) {
      const a = new T.Vector3(...from), b = new T.Vector3(...to), delta = b.clone().sub(a);
      const mesh = new T.Mesh(twigGeometry, timber);
      mesh.position.copy(a).add(b).multiplyScalar(.5);
      mesh.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), delta.clone().normalize());
      mesh.scale.set(radius, delta.length(), radius); mesh.castShadow = true; parent.add(mesh);
    }
    const dummy = new T.Object3D();
    function plant(parent, x, y, z, size) {
      const tree = new T.Group(); tree.position.set(x, y, z); parent.add(tree);
      cylinder(tree, 0, .23, 0, size * .56, .46, stone);
      cylinder(tree, 0, .47, 0, size * .51, .025, soil);
      branch(tree, [0, .45, 0], [.08 * size, size * 2.6, 0], .065 * size);
      const leaves = new T.InstancedMesh(foliageGeometry, leaf, 650);
      leaves.castShadow = true; leaves.receiveShadow = true;
      for (let i = 0; i < 650; i++) {
        const arm = i % 9, angle = arm * 2.399;
        const cx = Math.cos(angle) * size * .55, cz = Math.sin(angle) * size * .55;
        const cy = size * (1.7 + arm % 3 * .43);
        if (i < 9) branch(tree, [0, size * 1.2, 0], [cx, cy, cz], .024 * size);
        const a = random() * Math.PI * 2, r = Math.cbrt(random()) * size * .68, yy = random() * 2 - 1;
        dummy.position.set(cx + Math.cos(a) * r * Math.sqrt(1 - yy * yy), cy + yy * r, cz + Math.sin(a) * r * Math.sqrt(1 - yy * yy));
        const s = size * (.055 + random() * .07);
        dummy.scale.set(s * .65, s * .08, s * 1.2); dummy.rotation.set(random() * 3, random() * 3, random() * 3); dummy.updateMatrix();
        leaves.setMatrixAt(i, dummy.matrix); leaves.setColorAt(i, new T.Color().setHSL(.20 + random() * .08, .25 + random() * .3, .16 + random() * .14));
      }
      tree.add(leaves);
    }
    function planter(x, y, z, length) {
      box(site, x, y + .29, z, length, .58, .85, stone);
      box(site, x, y + .59, z, length - .15, .025, .69, soil, false);
      const shrubs = new T.InstancedMesh(foliageGeometry, leaf, Math.ceil(length * 65));
      shrubs.castShadow = true;
      for (let i = 0; i < shrubs.count; i++) {
        dummy.position.set(x + (random() - .5) * (length - .2), y + .66 + random() * .3, z + (random() - .5) * .65);
        dummy.rotation.set(0, random() * 6, 0); dummy.scale.set(.12, .12 + random() * .16, .12); dummy.updateMatrix();
        shrubs.setMatrixAt(i, dummy.matrix); shrubs.setColorAt(i, new T.Color().setHSL(.23, .25 + random() * .25, .17 + random() * .13));
      }
      site.add(shrubs);
    }

    planter(-7.5, .25, 9.5, 8.5);
    plant(site, -10.4, .25, 9.3, 1.25); plant(site, -5.3, .25, 9.4, .95);
    plant(site, 11, .28, 7.1, .58);
    for (let level = 1; level < levels; level++) {
      plant(site, 11.25, level * heights + .3, 7.1, .64);
      plant(site, 10.4, level * heights + .3, -5.6, .47);
    }
    // Planted flat roof, slim safety rails and a louvred plant enclosure.
    box(site, 0, roofY + .3, 0, 23.7, .07, 15.7, gravel);
    box(site, -1.5, roofY + .22, -4.25, 3.2, .22, 4.3, concrete);
    for (const z of [-8.1, 8.1]) {
      box(site, 0, roofY + .42, z, 24.8, .55, .28, stone);
      box(site, 0, roofY + .72, z, 24.9, .05, .38, edge);
      box(site, 0, roofY + 1.3, z, 24.7, .035, .035, metal);
      for (let x = -12; x <= 12; x += 2) box(site, x, roofY + 1, z, .035, .65, .035, metal);
    }
    for (const x of [-12.1, 12.1]) {
      box(site, x, roofY + .42, 0, .28, .55, 16.4, stone);
      box(site, x, roofY + 1.3, 0, .035, .035, 16.3, metal);
      for (let z = -8; z <= 8; z += 2) box(site, x, roofY + 1, z, .035, .65, .035, metal);
    }
    planter(-5, roofY + .35, 6.9, 12.7);
    for (const x of [-10, -6.2, -2.5]) plant(site, x, roofY + .35, 5.8, .45);

    const plantRoom = new T.Group(); plantRoom.position.y = roofY; scene.add(plantRoom);
    systems.push({ group: plantRoom, axis: 'y', delay: 1.45 });
    box(plantRoom, -1, 1.65, -2.5, 6.3, 2.5, 4.3, screen);
    box(plantRoom, -1, 2.97, -2.5, 6.6, .14, 4.6, edge);
    for (let y = .55; y < 2.9; y += .14) {
      for (const z of [-4.75, -.25]) box(plantRoom, -1, y, z, 6.5, .045, .12, duct);
      for (const x of [-4.25, 2.25]) box(plantRoom, x, y, -2.5, .12, .045, 4.6, duct);
    }
    for (const x of [-4.25, -1, 2.25]) for (const z of [-4.75, -.25]) box(plantRoom, x, 1.7, z, .09, 2.6, .09, edge);
    box(plantRoom, 7.5, 1.15, -4.5, 3.4, 1.6, 3.1, duct);
    for (const x of [6.5, 8.5]) {
      cylinder(plantRoom, x, 2.01, -4.5, .58, .12, screen);
      for (let bar = 0; bar < 8; bar++) box(plantRoom, x, 2.09, -4.98 + bar * .14, .92, .025, .025, edge);
    }
    box(plantRoom, 10.8, .85, -4.5, 3.4, .85, 1.3, duct);
    for (const x of [10, 11, 12]) box(plantRoom, x, .85, -4.5, .06, .92, 1.38, screen);
    for (let run = 0; run < 3; run++) pipe(plantRoom, [[12.65 - run * .23, .25, -6.4], [12.65 - run * .23, 1.15 + run * .16, -6.4], [3, 1.15 + run * .16, -6.4], [3, 2.5, -1], [2.2, 2.5, -1]]);

    const risers = new T.Group(); scene.add(risers);
    systems.push({ group: risers, axis: 'y', delay: 0 });
    box(risers, 12.15, (roofY + 1.2) / 2, -6.9, .8, roofY + 1.2, 1.05, duct);
    for (let y = .5; y < roofY + 1; y += 1.85) {
      box(risers, 12.15, y, -6.9, .86, .045, 1.11, duct);
      box(risers, 12.15, y, -7.55, .95, .08, .12, metal);
    }
    for (let run = 0; run < 3; run++) pipe(risers, [[12.65 - run * .23, .4, -6.4], [12.65 - run * .23, roofY + .3, -6.4]], .065);
    // Ground-level pumps, storage vessels and connected pipework.
    box(risers, 9.7, .4, -3.1, 4.1, .25, 5.4, concrete);
    for (const z of [-4.6, -2.3]) {
      cylinder(risers, 10, 1.5, z, .52, 2.05, duct);
      const cap = new T.Mesh(new T.SphereGeometry(1, 20, 12), duct);
      cap.position.set(10, 2.49, z); cap.scale.set(.52, .18, .52); cap.castShadow = true; risers.add(cap);
      cylinder(risers, 10, 2.55, z, .44, .08, screen);
      cylinder(risers, 10, 2.68, z, .08, .2, copper);
      pipe(risers, [[10, 2.8, z], [11.2, 2.8, z], [11.2, 1.1, -5.7], [12.65, 1.1, -5.7], [12.65, 1.1, -6.4]], .08);
      box(risers, 10.9, .68, z, .7, .35, .5, screen);
      cylinder(risers, 11.2, 1.3, z, .13, .15, bronze);
      const valve = new T.Mesh(new T.TorusGeometry(.14, .022, 6, 18), copper);
      valve.position.set(11.35, 1.42, z); valve.rotation.y = Math.PI / 2; risers.add(valve);
    }
    box(risers, 8.3, 1.4, -3.1, .5, 1.5, 1.2, white);
    box(risers, 8.58, 1.65, -3.1, .025, .3, .4, screen);


    // Batch repeated geometry per animated group; detail does not mean thousands of draw calls.
    const groups = [];
    scene.traverse(node => { if (node.isGroup) groups.push(node); });
    groups.forEach(group => {
      const batches = new Map();
      [...group.children].forEach(mesh => {
        if (!mesh.isMesh || mesh.isInstancedMesh) return;
        const key = `${mesh.geometry.uuid}/${mesh.material.uuid}/${mesh.castShadow}`;
        if (!batches.has(key)) batches.set(key, []);
        batches.get(key).push(mesh);
      });
      batches.forEach(meshes => {
        if (meshes.length < 3) return;
        const first = meshes[0], batch = new T.InstancedMesh(first.geometry, first.material, meshes.length);
        batch.castShadow = first.castShadow; batch.receiveShadow = true;
        meshes.forEach((mesh, i) => { mesh.updateMatrix(); batch.setMatrixAt(i, mesh.matrix); group.remove(mesh); });
        group.add(batch);
        if (first.material.transparent) transparentBatches.push({ batch, instances: meshes.map(mesh => ({ matrix: mesh.matrix.clone(), center: mesh.position.clone(), depth: 0 })) });
      });
    });
    const post = window.ArchPost;
    if (post && renderer.capabilities.isWebGL2) {
      composer = new post.EffectComposer(renderer);
      composer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
      composer.renderTarget1.samples = composer.renderTarget2.samples = 4;
      composer.addPass(new post.RenderPass(scene, camera));
      occlusion = new post.SSAOPass(scene, camera, 1, 1, 24);
      occlusion.kernelRadius = .75;
      occlusion.minDistance = .00015;
      occlusion.maxDistance = .01;
      const hideLines = occlusion.overrideVisibility.bind(occlusion);
      occlusion.overrideVisibility = () => {
        hideLines();
        scene.traverse(node => { if (node.material?.transparent) node.visible = false; });
      };
      composer.addPass(occlusion);
      composer.addPass(new post.OutputPass());
    }
    resize();
  }

  function resize() {
    if (!renderer) return;
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (composer) composer.setSize(w, h);
  }
  function viewDistance() {
    return Math.max(79, 112 / camera.aspect);
  }
  function placeCamera(azimuth, elevation, distance, targetY) {
    scene.fog.near = distance + 26;
    scene.fog.far = distance + 126;
    camera.position.set(Math.sin(azimuth) * Math.cos(elevation) * distance, targetY + Math.sin(elevation) * distance, Math.cos(azimuth) * Math.cos(elevation) * distance);
    camera.lookAt(0, targetY, 0);
  }
  function drawScene() {
    // Sort glass from the actual camera direction, including rear and overhead views.
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    const viewMatrix = new window.THREE.Matrix4(), point = new window.THREE.Vector3();
    transparentBatches.forEach(({ batch, instances }) => {
      viewMatrix.multiplyMatrices(camera.matrixWorldInverse, batch.matrixWorld);
      instances.forEach(instance => { instance.depth = point.copy(instance.center).applyMatrix4(viewMatrix).z; });
      instances.sort((a, b) => a.depth - b.depth);
      instances.forEach((instance, i) => batch.setMatrixAt(i, instance.matrix));
      batch.instanceMatrix.needsUpdate = true;
    });
    if (composer) composer.render();
    else renderer.render(scene, camera);
  }
  function render(t) {
    const turn = ease((t - 1.3) / 6.1);
    const distance = viewDistance() * (1.45 - turn * .45);
    const azimuth = .63 + turn * .33;
    const elevation = 1.15 - turn * 1.05;
    const targetY = 8.1 * turn;
    placeCamera(azimuth, elevation, distance, targetY);
    if (t < 2.2 || previous === 0) drawPlan(Math.min(2, t));
    board.material.opacity = 1 - .06 * ease((t - 4) / 3);
    floors.forEach(({ columns, deck }, i) => {
      const rise = ease((t - 1.8 - i * .7) / .45);
      columns.visible = rise > 0;
      columns.scale.y = Math.max(.001, rise);
      const slab = ease((t - 2.25 - i * .7) / .25);
      deck.visible = slab > 0;
      deck.scale.set(slab, Math.max(.01, slab), slab);
    });
    finishes.forEach((group, i) => {
      const f = ease((t - 5.1 - Math.min(i, 4) * .23) / .8);
      group.visible = f > 0;
      group.scale.y = Math.max(.001, f);
    });
    systems.forEach(({ group, axis, delay }) => {
      const f = ease((t - 7.2 - delay) / 1.1);
      group.visible = f > 0;
      group.scale[axis] = Math.max(.001, f);
    });
    const phase = t < 1.8 ? 0 : t < 5.1 ? 1 : t < 7.2 ? 2 : 3;
    const names = ['도면의 선이 공간의 기준이 됩니다.', '기둥과 보, 슬래브가 층별로 올라갑니다.', '석재와 유리, 목재 루버가 공간을 감쌉니다.', '덕트와 배관이 연결되며 건물이 완성됩니다.'];
    if (phaseLabel.textContent !== names[phase]) phaseLabel.textContent = names[phase];
    steps.forEach((step, i) => step.classList.toggle('is-current', i === phase));
    opening.dataset.phase = String(phase);
    progress.style.transform = `scaleX(${clamp(t / (duration / 1000))})`;
    drawScene();
  }
  function tick(now) {
    frame = 0;
    if (!active) return;
    // Pause the timeline while the tab is hidden.
    if (document.hidden) { frame = requestAnimationFrame(tick); return; }
    previous = now;
    const t = (now - start) / 1000;
    render(t);
    if (t * 1000 >= duration) explore();
    else frame = requestAnimationFrame(tick);
  }
  function open() {
    try { if (!renderer) setup(); }
    catch (error) { console.warn('Architectural intro unavailable:', error.message); close(); replay.hidden = true; return; }
    interactive = false;
    opening.dataset.interactive = 'false';
    controls.hidden = hint.hidden = true;
    renderer.shadowMap.autoUpdate = true;
    returnFocus = document.activeElement === document.body ? null : document.activeElement;
    page.forEach(node => { node.inert = true; });
    document.documentElement.classList.add('opening-active');
    opening.inert = false;
    opening.setAttribute('aria-hidden', 'false');
    opening.classList.add('is-open');
    active = true;
    skip.focus({ preventScroll: true });
    resize();
    start = performance.now(); previous = 0; hiddenAt = document.hidden ? start : null;
    if (reduce.matches) { render(duration / 1000); explore(); return; }
    frame = requestAnimationFrame(tick);
  }
  replay.addEventListener('click', open);
  document.addEventListener('visibilitychange', () => {
    if (!active) return;
    if (document.hidden) hiddenAt = performance.now();
    else if (hiddenAt !== null) { start += performance.now() - hiddenAt; hiddenAt = null; }
  });
  addEventListener('resize', () => { resize(); requestView(); });
  reduce.addEventListener('change', () => { if (active) close(); });
  if (!reduce.matches && !location.hash) open();
})();
