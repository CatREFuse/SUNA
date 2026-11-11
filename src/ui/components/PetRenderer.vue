<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Character } from '../types'
import { MAX_CAPTURE_SIDE, petIdentity } from '../../runtime/pet-capture-contract.mjs'

const props = withDefaults(defineProps<{ pet: NonNullable<Character['pet']>; speaking?: boolean; emotion?: string }>(), { speaking: false, emotion: '' })
const emit = defineEmits<{ ready: []; error: [error: unknown] }>()
const surface = ref<HTMLDivElement>(), state = ref('loading'), errorText = ref('')
let generation = 0, mounted = false, cleanups: Array<() => void | Promise<unknown>> = [], renderQueue = Promise.resolve()
let capturePixels: (() => { canvas: HTMLCanvasElement; frame?: number }) | undefined, renderedIdentity = ''
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
function dispose() { capturePixels = undefined; renderedIdentity = ''; const previous = cleanups; cleanups = []; const pending: Promise<unknown>[] = []; for (const cleanup of previous.reverse()) { try { pending.push(Promise.resolve(cleanup())) } catch { /* release the remaining resources too */ } } surface.value?.replaceChildren(); return Promise.allSettled(pending).then(() => undefined) }
function own(cleanup: () => void | Promise<unknown>) { cleanups.push(cleanup) }
function canvas() { const element = document.createElement('canvas'); element.setAttribute('aria-hidden', 'true'); element.style.cssText = 'display:block;width:100%;height:100%'; surface.value!.append(element); return element }
function observeSize(callback: (width: number, height: number) => void) {
  const resize = () => { const rect = surface.value?.getBoundingClientRect(); if (rect?.width && rect.height) callback(rect.width, rect.height) }
  const observer = new ResizeObserver(resize); observer.observe(surface.value!); own(() => observer.disconnect()); resize()
}
function frameLoop(run: number, callback: (elapsed: number, delta: number) => void) {
  let id = 0, start = 0, previous = 0
  const frame = (time: number) => {
    if (run !== generation) return
    if (!start) start = time
    const delta = previous ? Math.min((time - previous) / 1000, 0.05) : 0; previous = time
    if (!document.hidden) callback((time - start) / 1000, delta)
    id = requestAnimationFrame(frame)
  }
  id = requestAnimationFrame(frame); own(() => cancelAnimationFrame(id))
}
function ready(run: number) { if (run === generation) { renderedIdentity = petIdentity(props.pet); state.value = 'ready'; emit('ready') } }
function capture() {
  if (state.value !== 'ready' || !capturePixels || renderedIdentity !== petIdentity(props.pet)) throw Error('角色形象尚未准备好，或资源已发生变化')
  // Render synchronously before copying WebGL pixels. This does not require
  // preserveDrawingBuffer and never reads browser chrome, another window or the desktop.
  const current = capturePixels(), source = current.canvas, ratio = Math.min(1, MAX_CAPTURE_SIDE / Math.max(source.width, source.height))
  if (!source.width || !source.height) throw Error('角色画布尺寸无效')
  const output = document.createElement('canvas'); output.width = Math.max(1, Math.round(source.width * ratio)); output.height = Math.max(1, Math.round(source.height * ratio))
  const context = output.getContext('2d'); if (!context) throw Error('无法读取角色画布')
  context.drawImage(source, 0, 0, output.width, output.height)
  const data = output.toDataURL('image/png').slice('data:image/png;base64,'.length)
  return { data, mime: 'image/png', width: output.width, height: output.height, capturedAt: new Date().toISOString(), source: { assetUrl: props.pet.url, assetType: props.pet.type, assetIdentity: renderedIdentity, ...(current.frame === undefined ? {} : { frame: current.frame }) } }
}
async function imageRenderer(run: number) {
  const image = new Image(); image.decoding = 'async'; image.src = props.pet.url
  own(() => { image.onload = null; image.onerror = null; image.src = ''; image.remove() })
  await image.decode(); if (run !== generation) return
  const columns = props.pet.columns ?? 1, rows = props.pet.rows ?? 1, fps = props.pet.fps ?? 8
  if (![columns, rows, fps].every(Number.isInteger) || columns < 1 || rows < 1 || columns > 64 || rows > 64 || fps < 1 || fps > 60 || image.naturalWidth % columns || image.naturalHeight % rows) throw Error('帧动画行列需要均分图片，帧率应为 1–60。')
  if (columns === 1 && rows === 1 && !reducedMotion.matches) {
    capturePixels = () => { const target = document.createElement('canvas'), scale = Math.min(1, MAX_CAPTURE_SIDE / Math.max(image.naturalWidth, image.naturalHeight)); target.width = Math.max(1, Math.round(image.naturalWidth * scale)); target.height = Math.max(1, Math.round(image.naturalHeight * scale)); target.getContext('2d')!.drawImage(image, 0, 0, target.width, target.height); return { canvas: target, frame: 0 } }
    image.alt = ''; image.draggable = false; image.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;pointer-events:none'; surface.value!.append(image); ready(run); return
  }
  const element = canvas(), context = element.getContext('2d', { alpha: true }); if (!context) throw Error('无法初始化图片显示，请重新打开桌宠。')
  let width = 1, height = 1, current = -1, latest = 0
  const frameWidth = image.naturalWidth / columns, frameHeight = image.naturalHeight / rows
  const draw = (frame: number) => {
    context.clearRect(0, 0, element.width, element.height)
    const scale = Math.min(width / frameWidth, height / frameHeight), w = frameWidth * scale, h = frameHeight * scale
    context.drawImage(image, (frame % columns) * frameWidth, Math.floor(frame / columns) * frameHeight, frameWidth, frameHeight, (width - w) / 2, (height - h) / 2, w, h)
    element.dataset.frame = String(frame)
  }
  observeSize((w, h) => { width = w; height = h; const ratio = Math.min(devicePixelRatio || 1, 2); element.width = Math.round(w * ratio); element.height = Math.round(h * ratio); context.setTransform(ratio, 0, 0, ratio, 0, 0); draw(latest) })
  frameLoop(run, elapsed => { const next = reducedMotion.matches ? 0 : Math.floor(elapsed * fps) % (columns * rows); if (next !== current) { latest = current = next; draw(next) } })
  capturePixels = () => { draw(latest); return { canvas: element, frame: latest } }
  ready(run)
}
async function vrmRenderer(run: number) {
  const [THREE, { GLTFLoader }, { VRMLoaderPlugin, VRMUtils }] = await Promise.all([import('three'), import('three/addons/loaders/GLTFLoader.js'), import('@pixiv/three-vrm')])
  if (run !== generation) return
  const element = canvas(), renderer = new THREE.WebGLRenderer({ canvas: element, alpha: true, antialias: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.setClearColor(0x000000, 0); renderer.outputColorSpace = THREE.SRGBColorSpace
  own(() => { renderer.dispose(); renderer.forceContextLoss() })
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100)
  scene.add(new THREE.AmbientLight(0xffffff, 1.5)); const light = new THREE.DirectionalLight(0xffffff, 2); light.position.set(1, 2, 3); scene.add(light)
  const abort = new AbortController(); own(() => abort.abort())
  const response = await fetch(props.pet.url, { signal: abort.signal }); if (!response.ok) throw Error('VRM 文件无法读取，请重新导入形象。')
  const buffer = await response.arrayBuffer(); if (run !== generation) return
  const loader = new GLTFLoader(); loader.register(parser => new VRMLoaderPlugin(parser))
  const gltf = await loader.parseAsync(buffer, '')
  const vrm = gltf.userData.vrm as import('@pixiv/three-vrm').VRM | undefined
  if (run !== generation) { VRMUtils.deepDispose(gltf.scene); return }
  if (!vrm) { VRMUtils.deepDispose(gltf.scene); throw Error('这个文件没有可显示的 VRM 角色。') }
  own(() => VRMUtils.deepDispose(vrm.scene)); scene.add(vrm.scene); VRMUtils.rotateVRM0(vrm)
  vrm.humanoid?.setNormalizedPose({ leftUpperArm: { rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -1.1)).toArray() }, rightUpperArm: { rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 1.1)).toArray() } })
  vrm.update(0)
  const bounds = new THREE.Box3().setFromObject(vrm.scene), size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3())
  if (!Number.isFinite(size.y) || size.y <= 0) throw Error('VRM 模型没有可显示的网格。')
  observeSize((width, height) => {
    renderer.setSize(width, height, false); camera.aspect = width / height
    const distance = Math.max(size.y, size.x / camera.aspect) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.12
    camera.position.set(center.x, center.y, center.z + distance); camera.lookAt(center); camera.far = Math.max(100, distance * 5); camera.updateProjectionMatrix(); renderer.render(scene, camera)
  })
  const lookTarget = new THREE.Object3D(); lookTarget.position.set(0, center.y, 2); scene.add(lookTarget); if (vrm.lookAt) vrm.lookAt.target = lookTarget
  const pointer = (event: PointerEvent) => { const rect = element.getBoundingClientRect(); lookTarget.position.set((event.clientX - rect.left - rect.width / 2) / rect.width, center.y + (0.5 - (event.clientY - rect.top) / rect.height), 2) }
  element.addEventListener('pointermove', pointer); own(() => element.removeEventListener('pointermove', pointer))
  frameLoop(run, (elapsed, delta) => {
    const animated = !reducedMotion.matches
    const blink = animated && elapsed % 4.3 > 4.1 ? Math.sin((elapsed % 4.3 - 4.1) / 0.2 * Math.PI) : 0
    vrm.expressionManager?.setValue('blink', blink); vrm.expressionManager?.setValue('aa', props.speaking && animated ? 0.2 + Math.abs(Math.sin(elapsed * 11)) * 0.35 : 0)
    const chest = vrm.humanoid?.getNormalizedBoneNode('chest'); if (chest) chest.rotation.x = animated ? Math.sin(elapsed * 1.6) * 0.015 : 0
    vrm.update(animated ? delta : 0); renderer.render(scene, camera)
  })
  capturePixels = () => { renderer.render(scene, camera); return { canvas: element } }
  ready(run)
}
let corePromise: Promise<void> | undefined
function cubismCore() {
  if ((window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore) return Promise.resolve()
  if (!corePromise) corePromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script'); script.src = '/vendor/live2d/live2dcubismcore.min.js'; script.async = true
    script.onload = () => resolve(); script.onerror = () => { corePromise = undefined; script.remove(); reject(Error('Live2D 运行库无法加载，请检查应用安装是否完整。')) }; document.head.append(script)
  })
  return corePromise
}
async function live2dRenderer(run: number) {
  await cubismCore(); await import('pixi.js/unsafe-eval'); const [{ Application, Assets }, { Live2DModel }] = await Promise.all([import('pixi.js'), import('@jannchie/pixi-live2d-display/cubism4')])
  if (run !== generation) return
  // Load same-origin textures as HTML images; Cubism consumes GL textures directly.
  // This also avoids Pixi's worker data-URL feature probe under the desktop CSP.
  Assets.setPreferences({ preferWorkers: false, preferCreateImageBitmap: false })
  const app = new Application(), element = canvas()
  // The Cubism Pixi bridge uses logical renderer.width for its GL viewport; keep both coordinate systems equal.
  await app.init({ canvas: element, width: Math.max(1, surface.value!.clientWidth), height: Math.max(1, surface.value!.clientHeight), preference: 'webgl', backgroundAlpha: 0, antialias: true, resolution: 1, autoDensity: true, autoStart: false, sharedTicker: false })
  if (run !== generation) { app.destroy(true, { children: true }); return }
  own(() => { app.stop(); app.destroy(true, { children: true }) })
  const model = await Live2DModel.from(props.pet.url, { autoUpdate: false, autoInteract: false })
  const releaseModel = async () => {
    const urls = [...model.textureUrls]
    app.stage?.removeChild(model)
    // The bridge's texture:true destroy starts an unawaited Assets.unload. Own that
    // promise so a replacement model cannot reuse a texture being destroyed.
    model.destroy({ children: true })
    if (urls.length) await Assets.unload(urls)
  }
  if (run !== generation) { await releaseModel(); return }
  own(releaseModel)
  app.stage.addChild(model); model.setRenderer(app.renderer); model.anchor.set(0.5, 0.5)
  if (new URLSearchParams(location.search).get('petdebug') === '1') {
    const debugWindow = window as unknown as { __sandbookPetDiagnostics?: unknown }
    Object.defineProperty(debugWindow, '__sandbookPetDiagnostics', { configurable: true, get() {
      const bridge = model as any, renderer = app.renderer as any, gl = renderer.gl as WebGL2RenderingContext
      return { type: 'live2d', rendererUid: renderer.uid, contextId: bridge.glContextID, cachedTextures: bridge.cachedGlTextures?.map((texture: unknown) => ({ type: (texture as any)?.constructor?.name, instance: texture instanceof WebGLTexture, valid: texture instanceof WebGLTexture && gl.isTexture(texture) })), textures: bridge.textures?.map((texture: any) => {
        const source = texture.source, gpu = source?._gpuData?.[renderer.uid]
        return { width: source?.width, height: source?.height, alphaMode: source?.alphaMode, mipLevelCount: source?.mipLevelCount, resource: source?.resource?.constructor?.name, resourceWidth: source?.resource?.naturalWidth ?? source?.resource?.width, complete: source?.resource?.complete, gpuPresent: !!gpu, gpuTextureType: gpu?.texture?.constructor?.name, gpuInstance: gpu?.texture instanceof WebGLTexture, gpuValid: gpu?.texture instanceof WebGLTexture && gl.isTexture(gpu.texture) }
      }), coreTextures: Object.entries(bridge.internalModel?.renderer?.getBindedTextures?.() ?? {}).map(([key, texture]: [string, any]) => ({ key, type: texture?.constructor?.name, instance: texture instanceof WebGLTexture, valid: texture instanceof WebGLTexture && gl.isTexture(texture) })) }
    } })
    own(() => { delete debugWindow.__sandbookPetDiagnostics })
  }
  const modelWidth = model.internalModel?.width || model.width, modelHeight = model.internalModel?.height || model.height
  if (!modelWidth || !modelHeight) throw Error('Live2D 模型尺寸无效。')
  observeSize((width, height) => { app.renderer.resize(width, height); model.scale.set(Math.min(width / modelWidth, height / modelHeight) * 0.94); model.position.set(width / 2, height / 2); app.render() })
  const focus = (event: PointerEvent) => { if (reducedMotion.matches) return; const rect = element.getBoundingClientRect(); model.focus(event.clientX - rect.left, event.clientY - rect.top) }
  const tap = () => { const groups = Object.keys(model.internalModel?.motionManager.definitions ?? {}); const group = groups.find(name => /tap|touch/i.test(name)); if (group && !reducedMotion.matches) void model.motion(group) }
  element.addEventListener('pointermove', focus); element.addEventListener('click', tap); own(() => { element.removeEventListener('pointermove', focus); element.removeEventListener('click', tap) })
  frameLoop(run, (elapsed, delta) => { if (!reducedMotion.matches) model.update(delta * 1000); model.setParameterValue('ParamMouthOpenY', props.speaking ? 0.2 + Math.abs(Math.sin(elapsed * 11)) * 0.35 : 0); app.render() })
  capturePixels = () => { app.render(); return { canvas: element } }
  ready(run)
}
function render() {
  if (!mounted) return Promise.resolve()
  const run = ++generation, released = dispose(); state.value = 'loading'; errorText.value = ''
  renderQueue = renderQueue.then(async () => {
    await released
    if (run !== generation || !mounted) return
    try {
      if (!props.pet.url.startsWith('/assets-local/')) throw Error('请先在角色设置中导入本地形象。')
      if (props.pet.type === 'frames') await imageRenderer(run)
      else if (props.pet.type === 'vrm') await vrmRenderer(run)
      else if (props.pet.type === 'live2d') await live2dRenderer(run)
      else throw Error('不支持的桌宠形象。')
    } catch (error) {
      if (run !== generation) return
      await dispose()
      if (run !== generation) return
      state.value = 'error'; errorText.value = error instanceof Error ? error.message : '形象无法加载，请重新导入。'; emit('error', error)
    }
  })
  return renderQueue
}
// Snapshot polling replaces the pet object. Compare its primitive fields so an
// unchanged snapshot never tears down a live GPU model or its shared textures.
watch([() => props.pet.type, () => props.pet.url, () => props.pet.columns, () => props.pet.rows, () => props.pet.fps], render)
const motionChanged = () => { void render() }
onMounted(() => { mounted = true; reducedMotion.addEventListener('change', motionChanged); void render() })
onBeforeUnmount(() => { mounted = false; generation++; reducedMotion.removeEventListener('change', motionChanged); dispose() })
defineExpose({ reload: render, capture })
</script>

<template>
  <div class="pet-renderer" :data-render-state="state" :data-render-type="pet.type">
    <div ref="surface" class="pet-render-surface" role="img" :aria-label="pet.name || '桌面角色'"/>
    <div v-if="state !== 'ready'" class="pet-render-message" :role="state === 'error' ? 'alert' : 'status'">
      <p>{{ state === 'loading' ? '正在加载形象…' : errorText }}</p>
      <button v-if="state === 'error'" type="button" @click="render">重新加载</button>
    </div>
  </div>
</template>

<style scoped>
.pet-renderer,.pet-render-surface{width:100%;height:100%;min-width:0;min-height:0;position:relative}.pet-render-message{position:absolute;inset:auto 20px 32px;padding:12px 16px;background:var(--sand-bg-elevated,var(--surface,#fff));color:var(--sand-text-primary,var(--text,#242421));border-radius:14px;font-size:13px;line-height:18px;text-align:center}.pet-render-message p{margin:0;overflow-wrap:anywhere}.pet-render-message button{appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-weight:400;min-height:30px;padding:4px 12px;margin-top:4px;cursor:pointer;border-radius:15px}.pet-render-message button:focus-visible{outline:2px solid var(--sand-focus-ring-primary,var(--focus));outline-offset:2px;background:var(--hover);text-underline-offset:4px}.pet-render-message button:hover{background:rgba(127,127,127,.12)}
</style>
