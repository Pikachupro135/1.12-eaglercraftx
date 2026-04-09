// vr-wrapper.js
// WebXR "big screen" VR for Eaglercraft 1.12 + simple fake VR hands

let gameCanvas = null;

// Try to find the main game canvas that the engine creates
function findGameCanvas() {
  const canvases = document.getElementsByTagName('canvas');
  if (canvases.length > 0) {
    // Assume the first canvas is the game canvas
    gameCanvas = canvases[0];
    console.log('[VR] Found game canvas:', gameCanvas);
    return true;
  }
  return false;
}

// Poll for the canvas until it appears
const canvasPoll = setInterval(() => {
  if (findGameCanvas()) {
    clearInterval(canvasPoll);
    setupVR();
  }
}, 500);

let glCanvas;
let gl;

let xrSession = null;
let xrRefSpace = null;

let quadProgram;
let quadPositionBuffer;
let quadTexcoordBuffer;
let quadTexture;

// controller state for "hands"
let controllerStates = [];

// Called once after we find the game canvas
function setupVR() {
  console.log('[VR] Setting up VR wrapper');

  // Hidden canvas used as the WebXR render target
  glCanvas = document.createElement('canvas');
  glCanvas.width = 2048;
  glCanvas.height = 2048;
  glCanvas.style.display = 'none';
  document.body.appendChild(glCanvas);

  gl = glCanvas.getContext('webgl', { xrCompatible: true });
  if (!gl) {
    console.error('[VR] WebGL context for XR could not be created');
    return;
  }

  const btn = document.getElementById('enter-vr');
  if (btn) {
    btn.addEventListener('click', () => {
      initVR().catch(err => {
        console.error('[VR] initVR error:', err);
        alert('Failed to start VR: ' + err.message);
      });
    });
  } else {
    console.warn('[VR] VR button not found');
  }
}

// == Shader helpers ==
function createShader(gl, type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('[VR] Shader compile error:', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function createProgram(gl, vsSource, fsSource) {
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('[VR] Program link error:', gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

// == Quad + texture from game canvas ==
function initQuad() {
  const vsSource = `
    attribute vec2 aPosition;
    attribute vec2 aTexcoord;
    varying vec2 vTexcoord;
    void main() {
      gl_Position = vec4(aPosition, 0.0, 1.0);
      vTexcoord = aTexcoord;
    }
  `;

  const fsSource = `
    precision mediump float;
    varying vec2 vTexcoord;
    uniform sampler2D uTexture;
    void main() {
      gl_FragColor = texture2D(uTexture, vTexcoord);
    }
  `;

  quadProgram = createProgram(gl, vsSource, fsSource);
  if (!quadProgram) {
    console.error('[VR] Failed to create quad program');
    return;
  }

  const positions = new Float32Array([
    -1, -1,
     1, -1,
    -1,  1,
     1,  1
  ]);

  const texcoords = new Float32Array([
    0, 1,
    1, 1,
    0, 0,
    1, 0
  ]);

  quadPositionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadPositionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

  quadTexcoordBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadTexcoordBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, texcoords, gl.STATIC_DRAW);

  quadTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, quadTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

// Copy the current game canvas into a texture
function updateGameTexture() {
  if (!gameCanvas) return;
  gl.bindTexture(gl.TEXTURE_2D, quadTexture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    gameCanvas
  );
}

// == WebXR setup ==
async function initVR() {
  if (!navigator.xr) {
    alert('WebXR not supported in this browser');
    return;
  }

  const supported = await navigator.xr.isSessionSupported('immersive-vr');
  if (!supported) {
    alert('Immersive VR not supported on this device/browser');
    return;
  }

  xrSession = await navigator.xr.requestSession('immersive-vr', {
    requiredFeatures: ['local-floor']
  });

  await gl.makeXRCompatible();
  const xrLayer = new XRWebGLLayer(xrSession, gl);
  xrSession.updateRenderState({ baseLayer: xrLayer });

  xrRefSpace = await xrSession.requestReferenceSpace('local-floor');

  xrSession.addEventListener('end', () => {
    console.log('[VR] Session ended');
    xrSession = null;
    xrRefSpace = null;
  });

  initQuad();

  xrSession.requestAnimationFrame(onXRFrame);
}

// Update controller poses each frame
function updateControllers(frame) {
  controllerStates = [];

  if (!xrSession || !xrRefSpace) return;

  for (const inputSource of xrSession.inputSources) {
    if (!inputSource.gripSpace) continue;

    const gripPose = frame.getPose(inputSource.gripSpace, xrRefSpace);
    if (!gripPose) continue;

    controllerStates.push({
      gripPose,
      handedness: inputSource.handedness || 'unknown'
    });
  }
}

// Map 3D controller position to 2D clip space for a "fake" hand
function controllerToScreenPos(pos) {
  // pos = DOMPointReadOnly with x,y,z in meters
  const scale = 0.3; // tweak if too big/small
  const x = pos.x * scale;
  const y = (pos.y - 1.2) * scale; // shift down a bit so they are near center

  const clamp = v => Math.max(-0.8, Math.min(0.8, v));
  return { x: clamp(x), y: clamp(y) };
}

// Draw a simple colored square at an NDC position
function drawHandAt(x, y, color) {
  const size = 0.1;
  const x1 = x - size;
  const x2 = x + size;
  const y1 = y - size;
  const y2 = y + size;

  const positions = new Float32Array([
    x1, y1,
    x2, y1,
    x1, y2,
    x2, y2
  ]);

  if (!drawHandAt.program) {
    const vsSource = `
      attribute vec2 aPosition;
      void main() {
        gl_Position = vec4(aPosition, 0.0, 1.0);
      }
    `;
    const fsSource = `
      precision mediump float;
      uniform vec3 uColor;
      void main() {
        gl_FragColor = vec4(uColor, 1.0);
      }
    `;
    drawHandAt.program = createProgram(gl, vsSource, fsSource);
    drawHandAt.buffer = gl.createBuffer();
    drawHandAt.posLoc = gl.getAttribLocation(drawHandAt.program, 'aPosition');
    drawHandAt.colorLoc = gl.getUniformLocation(drawHandAt.program, 'uColor');
  }

  gl.useProgram(drawHandAt.program);
  gl.bindBuffer(gl.ARRAY_BUFFER, drawHandAt.buffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);

  gl.enableVertexAttribArray(drawHandAt.posLoc);
  gl.vertexAttribPointer(drawHandAt.posLoc, 2, gl.FLOAT, false, 0, 0);

  gl.uniform3fv(drawHandAt.colorLoc, new Float32Array(color));

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// Main XR frame loop
function onXRFrame(time, frame) {
  const session = frame.session;
  const pose = frame.getViewerPose(xrRefSpace);
  const glLayer = session.renderState.baseLayer;

  // update controller positions
  updateControllers(frame);

  gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
  gl.clearColor(0.0, 0.0, 0.0, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // Copy the game canvas into the texture each frame
  updateGameTexture();

  if (pose) {
    for (const view of pose.views) {
      const viewport = glLayer.getViewport(view);
      gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);

      // Draw the big game screen
      gl.useProgram(quadProgram);

      const posLoc = gl.getAttribLocation(quadProgram, 'aPosition');
      const texLoc = gl.getAttribLocation(quadProgram, 'aTexcoord');
      const samplerLoc = gl.getUniformLocation(quadProgram, 'uTexture');

      gl.enableVertexAttribArray(posLoc);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadPositionBuffer);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

      gl.enableVertexAttribArray(texLoc);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadTexcoordBuffer);
      gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, quadTexture);
      gl.uniform1i(samplerLoc, 0);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Draw "hands" on top as colored squares
      for (const ctrl of controllerStates) {
        const p = ctrl.gripPose.transform.position;
        const pos2D = controllerToScreenPos(p);

        const color = ctrl.handedness === 'left' ? [0.2, 0.4, 1.0] :
                      ctrl.handedness === 'right' ? [1.0, 0.3, 0.3] :
                      [0.7, 0.7, 0.7];

        drawHandAt(pos2D.x, pos2D.y, color);
      }
    }
  }

  session.requestAnimationFrame(onXRFrame);
}
