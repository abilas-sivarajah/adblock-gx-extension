// Is hardware acceleration on? (popup and content/discord_hint.js)
// Without it Chrome/Opera draw WebGL in software ("Microsoft Basic Render Driver", "SwiftShader")
// or not at all - then DRM video is no longer shown via a protected overlay and Discord's screen
// share captures it.
function abGpuInfo() {
    let renderer = '';
    try {
        const gl = document.createElement('canvas').getContext('webgl');
        if (!gl) return {accelerated: false, renderer: 'kein WebGL'};
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
    } catch (e) {
        return {accelerated: true, renderer: '?'};  // unknown: rather show the hint
    }
    return {accelerated: !/SwiftShader|Basic Render|llvmpipe|software/i.test(renderer), renderer: renderer};
}
