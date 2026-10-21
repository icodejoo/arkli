/**
 * 随机点名 3D 滚筒舞台渲染器：基于 Three.js 实现多环圆柱、图集文本合批、旋转刹停、弹出高亮与粒子爆发。
 */
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three'
import { vibrate, cancelVibrate } from '@/native/system'
import {
  buildRingLayout,
  calcAtlasGrid,
  calcAtlasUv,
  calcRingMotion,
  DEFAULT_TARGET_ROUNDS,
  calcStopAngle,
  calcSpinAngle,
  calcTargetRounds,
  rpmToRadPerMs,
  rpsToRadPerMs,
  SPIN_RAD_PER_MS,
  calcStopTarget,
  calcApproachAngle,
  normalizeAngle,
  calcDragAngle,
  calcInertiaStep,
  clampInertiaSpeed,
  smoothDragVelocity,
  isHorizontalIntent,
  DRAG_HOLD_MS,
  ACTIVE_FRAME_MS,
  IDLE_FRAME_MS,
  FRAME_TOLERANCE_MS,
  calcPixelRatio,
  shouldRenderFrame,
  MANUAL_STOP_MS,
  SETTLE_HOLD_MS,
  SLOTS_PER_RING,
  truncateName,
  type RingLayoutResult,
  type RingMotionConfig,
} from './ring-layout'

/** 舞台卡片固定暗黑背景色 */
export const COLOR_STAGE_BG = '#0e1017'
/** 主题色备用默认值 */
export const COLOR_FALLBACK_PRIMARY = '#3b6cf6'
/** 字体族 */
const FONT_FAMILY = 'system-ui, -apple-system, sans-serif'

/** 滚筒圆柱半径 */
const CYLINDER_RADIUS = 2.4
/** 单环高度 */
const RING_HEIGHT = 0.52
/** 环间隙 */
const RING_GAP = 0.08
/** 图集固定宽度 */
const ATLAS_WIDTH = 1024
/** 图集单元格高度 */
const ATLAS_CELL_HEIGHT = 48

/** 动画总时长（毫秒） */
export const STAGE_ANIM_MS = 1200
/** 转动震动节流间隔（毫秒） */
const VIBRATE_INTERVAL_MS = 120
/** 轻微震动时长（毫秒） */
const VIBRATE_TICK_MS = 15
/** 停下重震配置 */
const VIBRATE_HEAVY_PATTERN = [0, 50]

/** 达到此像素比及以上时关闭抗锯齿 */
const NO_AA_PIXEL_RATIO = 2
/** 转子结算前的暗淡透明度 */
const RING_DIM_OPACITY = 0.1
/** 结算后转子图集的高斯模糊半径（图集像素） */
const RING_BLUR_PX = 1.5
/** 结算后转子缓慢转动的角速度（弧度/毫秒，约 40 秒一圈） */
const SLOW_ROTATE_SPEED = (Math.PI * 2) / 40000
/** 弹出结束时中奖者缩放 */
const WINNER_POP_SCALE = 1.35
/** 中奖者初始 z（贴在筒前） */
const WINNER_BASE_Z = CYLINDER_RADIUS + 0.3
/** 弹出结束时中奖者 z */
const WINNER_POP_Z = CYLINDER_RADIUS + 0.5

/** 中奖者卡片平面宽高 */
const WINNER_PLANE_W = 2.4
const WINNER_PLANE_H = 0.75

/** 粒子爆发总数 */
const PARTICLE_COUNT = 60
/** 粒子消散时长（毫秒） */
const PARTICLE_LIFETIME_MS = 800
/** 粒子阻尼衰减的基准帧时长（秒），阻尼按真实经过时间折算 */
const PARTICLE_BASE_DT = 0.016
/** 粒子每基准帧速度保留比例 */
const PARTICLE_DAMPING = 0.95
/** 渲染顺序：转子 < 中奖者 < 粒子（已关深度测试，靠顺序保证叠放） */
const ORDER_WINNER = 1
const ORDER_PARTICLES = 2
/** 转动开始后多久预生成结算模糊图集（毫秒），避免结算帧集中卡顿 */
const BLUR_PREPARE_DELAY_MS = 250
/** 弹出放大动效时长（毫秒） */
const POP_DURATION_MS = 300

/**
 * 缓动函数：三次方减速。
 *
 * @param t 归一化时间 (0~1)
 * @returns 缓动值 (0~1)
 */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

/**
 * 探测环境是否支持 WebGL。
 *
 * @returns true 表示支持 WebGL
 * @example if (!isWebGLSupported()) fallbackToText()
 */
export function isWebGLSupported(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
    )
  } catch {
    return false
  }
}

/**
 * 读取当前环境的主题主色。
 *
 * @param container 容器 DOM 元素
 * @returns 主题色 Hex 字符串
 */
function readPrimaryColor(container: HTMLElement): string {
  try {
    const val = getComputedStyle(container).getPropertyValue('--van-primary-color').trim()
    return val || COLOR_FALLBACK_PRIMARY
  } catch {
    return COLOR_FALLBACK_PRIMARY
  }
}

/**
 * 单环在 3D 场景中的运行时状态
 */
interface RingRuntime {
  /** 环 Mesh */
  mesh: Mesh<BufferGeometry, MeshBasicMaterial>
  /** 环几何体 */
  geometry: BufferGeometry
  /** 运动参数 */
  motion: RingMotionConfig
  /** 最终目标角度 */
  targetAngle: number
  /** 滚动起点角度（承接慢转角度） */
  startAngle: number
  /** 手动停止：减速起点角度 */
  stopFrom: number
  /** 手动停止：减速终点角度 */
  stopTo: number
}

/**
 * 粒子运行时状态
 */
interface ParticleState {
  points: Points<BufferGeometry, PointsMaterial>
  velocities: Float32Array
  startTime: number
}

/** 开抽可选项 */
export interface PlayOptions {
  /** 手动模式：不自动停，等 stop() */
  manual?: boolean
  /** 自动模式转动时长（毫秒），缺省用 STAGE_ANIM_MS */
  durationMs?: number
  /** 抽奖转速（圈/秒），缺省用内置默认值 */
  spinRps?: number
}

/** 舞台视觉/速度配置 */
export interface StageConfig {
  /** 结算后转子的高斯模糊半径（px，0 为不模糊） */
  blurPx: number
  /** 闲时（预览、结算后）转速（圈/分） */
  idleRpm: number
}

/**
 * 3D 滚筒舞台控制器接口
 */
export interface RollCallStage3D {
  /**
   * 启动一次开抽动画表演。
   *
   * @param names 候选名单
   * @param winner 中奖名字
   * @param onFinish 表演结束回调
   * @param opts 可选项，manual 为 true 时匀速一直转，直到调用 stop()
   */
  play: (names: readonly string[], winner: string, onFinish?: () => void, opts?: PlayOptions) => void
  /**
   * 预览名单：名单有效但未开抽时，生成清晰的转子并一直缓慢旋转（低帧率）；滚动/结算停顿中忽略。
   *
   * @param names 有效名单（至少 1 人）
   * @example stage.preview(['张三', '李四'])
   */
  preview: (names: readonly string[]) => void
  /**
   * 清空转子并停止渲染（名单为空时调用）；滚动/结算停顿中忽略。
   *
   * @example stage.clear()
   */
  clear: () => void
  /**
   * 手动模式下请求停止：滚筒从当前角度减速落到中奖者；非手动模式、未在滚动或已请求过则忽略。
   */
  stop: () => void
  /**
   * 立即跳到结算结果并结束动画。
   */
  settleNow: () => void
  /**
   * 暂停或恢复结算后的转子慢转（浮起/离开前台时暂停，避免空转出帧）。
   *
   * @param paused true 暂停转子停转不出帧，false 恢复慢转
   * @example stage.setPaused(true)
   */
  setPaused: (paused: boolean) => void
  /**
   * 更新舞台配置（模糊、闲时转速），立即生效。
   *
   * @param cfg 配置
   * @example stage.configure({ blurPx: 1.5, idleRpm: 1.5 })
   */
  configure: (cfg: StageConfig) => void
  /**
   * 彻底销毁 3D 场景并释放 WebGL 资源。
   */
  dispose: () => void
}

/**
 * 创建并挂载 3D 随机点名滚筒舞台。
 *
 * @param container 挂载目标容器 DOM
 * @returns 舞台控制器实例
 * @example const stage = createRollCallStage(containerRef.value)
 */
export function createRollCallStage(container: HTMLElement): RollCallStage3D {
  const scene = new Scene()
  const camera = new PerspectiveCamera(42, 1, 0.1, 100)
  camera.position.set(0, 0, 6.2)
  camera.lookAt(0, 0, 0)

  const dpr = window.devicePixelRatio || 1
  const initW = container.clientWidth || 300
  const initH = container.clientHeight || 180
  const renderer = new WebGLRenderer({
    alpha: true,
    antialias: dpr < NO_AA_PIXEL_RATIO,
    powerPreference: 'low-power',
    stencil: false,
    depth: false,
    precision: 'mediump',
  })
  renderer.setPixelRatio(calcPixelRatio(dpr, initW, initH))
  renderer.setSize(initW, initH, false)
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.pointerEvents = 'none'
  container.appendChild(renderer.domElement)

  /**
   * 预编译着色器：用与实际一致的材质参数先渲染一次，避免结算出粒子时现编译导致掉帧
   */
  function warmUpShaders(): void {
    const probeCanvas = document.createElement('canvas')
    probeCanvas.width = probeCanvas.height = 2
    const probeTex = new CanvasTexture(probeCanvas)
    const probeMesh = new Mesh(
      new BufferGeometry(),
      new MeshBasicMaterial({ map: probeTex, transparent: true, depthTest: false, depthWrite: false }),
    )
    const probePoints = new Points(
      new BufferGeometry(),
      new PointsMaterial({ transparent: true, depthTest: false, depthWrite: false }),
    )
    scene.add(probeMesh, probePoints)
    try {
      renderer.compile(scene, camera)
    } catch {
      // 预编译失败不影响正式渲染
    }
    scene.remove(probeMesh, probePoints)
    probeMesh.geometry.dispose()
    probeMesh.material.dispose()
    probePoints.geometry.dispose()
    probePoints.material.dispose()
    probeTex.dispose()
  }
  warmUpShaders()

  const cylinderGroup = new Group()
  scene.add(cylinderGroup)

  let atlasTexture: CanvasTexture | null = null
  /** 清晰图集画布（结算时据此生成模糊副本） */
  let atlasCanvasRef: HTMLCanvasElement | null = null
  /** 结算后使用的模糊图集纹理（懒创建） */
  let blurTexture: CanvasTexture | null = null
  let ringMaterial: MeshBasicMaterial | null = null
  let rings: RingRuntime[] = []
  let winnerMesh: Mesh<BufferGeometry, MeshBasicMaterial> | null = null
  let winnerTexture: CanvasTexture | null = null
  let particleState: ParticleState | null = null
  /** 待生成的中奖者卡片信息（生成后置空） */
  let pendingWinner: { name: string; color: string } | null = null

  let animFrameId = 0
  let startTime = 0
  let isRolling = false
  /** 手动模式（匀速一直转，等 stop） */
  let manual = false
  /** 抽奖转速（弧度/毫秒） */
  let spinRad = SPIN_RAD_PER_MS
  /** 闲时转速（弧度/毫秒） */
  let slowRad = SLOW_ROTATE_SPEED
  /** 本次中奖环额外整圈数 */
  let targetRounds = DEFAULT_TARGET_ROUNDS
  /** 结算模糊半径（px） */
  let blurPx = RING_BLUR_PX
  /** 自动模式本次转动时长（毫秒） */
  let animMs = STAGE_ANIM_MS
  /** 手动模式点停止的时刻（0 表示尚未停止） */
  let stopStartTime = 0
  let lastVibrateTime = 0
  let finishCallback: (() => void) | null = null
  let currentWinner = ''
  let popStartTime = 0
  /** 结算阶段起点（0 表示未进入） */
  let settleStartTime = 0
  /** 上一帧转子缓慢转动的时间戳（0 表示未开始） */
  let lastSlowTime = 0
  /** 是否已进入结算静止态（转子持续慢转，直到下次开抽/销毁） */
  let settled = false
  /** 是否被暂停（暂停时转子停转、不排 rAF） */
  let paused = false
  /** rAF 是否已排队 */
  let frameQueued = false
  /** 空闲慢转的延时定时器 id（0 表示无） */
  let idleTimerId = 0
  /** 上次真正渲染的时间戳（0 表示未渲染过） */
  let lastRenderTime = 0
  /** 当前拖动的指针 id（-1 表示未在拖动） */
  let dragPointerId = -1
  /** 拖动是否已判定为水平意图并接管 */
  let dragLocked = false
  /** 拖动按下点坐标 */
  let dragStartX = 0
  let dragStartY = 0
  /** 拖动开始时各环角度 */
  let dragBaseAngles: number[] = []
  /** 上次拖动采样的 x、时间戳与测得的平滑角速度 */
  let dragLastX = 0
  let dragLastTime = 0
  let dragVelocity = 0
  /** 惯性额外角速度（弧度/毫秒，叠加在各环慢转之上，0 表示无惯性） */
  let inertiaVelocity = 0
  /** 上一帧粒子更新的时间戳（0 表示未开始） */
  let lastParticleTime = 0
  /** 预览态：名单有效但未开抽，转子清晰慢转 */
  let previewing = false
  /** 页面是否在后台 */
  let hidden = typeof document !== 'undefined' && document.hidden
  let disposed = false

  /**
   * 请求渲染一帧；循环仅在有动画时持续，静止即停。
   */
  function requestFrame(delayMs = 0): void {
    if (frameQueued || disposed) return
    frameQueued = true
    if (delayMs > 0) {
      idleTimerId = window.setTimeout(() => {
        idleTimerId = 0
        animFrameId = requestAnimationFrame(renderLoop)
      }, delayMs)
    } else {
      animFrameId = requestAnimationFrame(renderLoop)
    }
  }

  /**
   * 是否只剩结算后的空闲慢转（可用低帧率）
   */
  function isIdleOnly(): boolean {
    return (
      (settled || previewing) &&
      !isRolling &&
      settleStartTime === 0 &&
      popStartTime === 0 &&
      !particleState &&
      !dragLocked &&
      inertiaVelocity === 0
    )
  }

  /**
   * 当前是否允许拖动转子：有转子、非滚动/落定停顿、未暂停且页面可见
   */
  function canDrag(): boolean {
    return !disposed && !hidden && !paused && rings.length > 0 && !isRolling && settleStartTime === 0
  }

  /**
   * 立刻安排下一帧（取消空闲低帧率的等待，让拖动跟手）
   */
  function expediteFrame(): void {
    if (idleTimerId) {
      clearTimeout(idleTimerId)
      idleTimerId = 0
      frameQueued = false
    }
    requestFrame()
  }

  /**
   * 结束拖动状态并释放指针捕获（不改变角度与惯性）
   */
  function endDragState(): void {
    if (dragPointerId >= 0) {
      try {
        container.releasePointerCapture(dragPointerId)
      } catch {
        // 指针已失效，忽略
      }
    }
    dragPointerId = -1
    dragLocked = false
  }

  /**
   * 指针按下：可拖时记录起点与各环角度
   */
  function onPointerDown(e: PointerEvent): void {
    if (dragPointerId >= 0 || !canDrag()) return
    dragPointerId = e.pointerId
    dragLocked = false
    dragStartX = dragLastX = e.clientX
    dragStartY = e.clientY
    dragLastTime = e.timeStamp
    dragVelocity = 0
    dragBaseAngles = rings.map((r) => r.mesh.rotation.y)
  }

  /**
   * 指针移动：判定水平意图后接管，各环同向跟手转动并测速
   */
  function onPointerMove(e: PointerEvent): void {
    if (e.pointerId !== dragPointerId) return
    if (!canDrag()) {
      endDragState()
      return
    }
    const dx = e.clientX - dragStartX
    if (!dragLocked) {
      if (!isHorizontalIntent(dx, e.clientY - dragStartY)) return
      dragLocked = true
      inertiaVelocity = 0
      dragBaseAngles = rings.map((r) => r.mesh.rotation.y)
      dragStartX = dragLastX = e.clientX
      dragLastTime = e.timeStamp
      try {
        container.setPointerCapture(e.pointerId)
      } catch {
        // 指针已失效，忽略
      }
      expediteFrame()
      return
    }
    const total = e.clientX - dragStartX
    rings.forEach((r, i) => {
      // 各环沿自己原本的方向转（交错），向右拖为顺各环原方向加速
      r.mesh.rotation.y = (dragBaseAngles[i] ?? 0) + r.motion.direction * calcDragAngle(0, total)
    })
    const dAngle = calcDragAngle(0, e.clientX - dragLastX)
    dragVelocity = smoothDragVelocity(dragVelocity, dAngle, e.timeStamp - dragLastTime)
    dragLastX = e.clientX
    dragLastTime = e.timeStamp
    requestFrame()
  }

  /**
   * 指针抬起/取消：已接管拖动则带当前角速度进入惯性
   */
  function onPointerEnd(e: PointerEvent): void {
    if (e.pointerId !== dragPointerId) return
    const wasLocked = dragLocked
    endDragState()
    if (!wasLocked) return
    inertiaVelocity = e.timeStamp - dragLastTime > DRAG_HOLD_MS ? 0 : clampInertiaSpeed(dragVelocity)
    lastSlowTime = 0
    expediteFrame()
  }
  container.style.touchAction = 'pan-y'
  container.addEventListener('pointerdown', onPointerDown)
  container.addEventListener('pointermove', onPointerMove)
  container.addEventListener('pointerup', onPointerEnd)
  container.addEventListener('pointercancel', onPointerEnd)

  /**
   * 页面可见性变化：切后台不再出帧，回前台恢复
   */
  function onVisibility(): void {
    hidden = document.hidden
    if (!hidden) {
      lastSlowTime = 0
      requestFrame()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)

  /**
   * 监听容器尺寸变化自适应渲染器
   */
  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) {
        camera.aspect = width / height
        camera.updateProjectionMatrix()
        renderer.setPixelRatio(calcPixelRatio(dpr, width, height))
        renderer.setSize(width, height, false)
        requestFrame()
      }
    }
  })
  resizeObserver.observe(container)

  /**
   * 绘制文字图集 Canvas
   */
  function buildAtlasCanvas(layout: RingLayoutResult, primaryColor: string, highlight: boolean): HTMLCanvasElement {
    const { columns, rows } = calcAtlasGrid(layout.totalSlots)
    const cellW = ATLAS_WIDTH / columns
    const cellH = ATLAS_CELL_HEIGHT
    const canvas = document.createElement('canvas')
    canvas.width = ATLAS_WIDTH
    canvas.height = rows * cellH
    const ctx = canvas.getContext('2d')
    if (!ctx) return canvas

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (const ring of layout.rings) {
      for (const slot of ring.slots) {
        const col = slot.globalIndex % columns
        const row = Math.floor(slot.globalIndex / columns)
        const x = col * cellW
        const y = row * cellH

        // 单元格半透明背景与细边框
        ctx.fillStyle = 'rgba(255, 255, 255, 0.03)'
        ctx.fillRect(x + 2, y + 2, cellW - 4, cellH - 4)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
        ctx.lineWidth = 1
        ctx.strokeRect(x + 2, y + 2, cellW - 4, cellH - 4)

        // 名字文字绘制
        const displayName = truncateName(slot.name, 6)
        ctx.font = `600 ${displayName.length > 4 ? 18 : 22}px ${FONT_FAMILY}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const lit = highlight && slot.isWinner
        ctx.fillStyle = lit ? '#ffffff' : '#cfd8ea'
        ctx.shadowColor = lit ? primaryColor : 'transparent'
        ctx.shadowBlur = lit ? 8 : 0
        ctx.fillText(displayName, x + cellW / 2, y + cellH / 2)
      }
    }
    return canvas
  }

  /**
   * 绘制中奖者大字号独立弹出卡片纹理
   */
  function buildWinnerTexture(name: string, primaryColor: string): CanvasTexture {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 160
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      // 大字号中奖者名字
      const displayName = truncateName(name, 8)
      const fontSize = displayName.length > 5 ? 40 : 52
      ctx.font = `bold ${fontSize}px ${FONT_FAMILY}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#ffffff'
      ctx.shadowColor = primaryColor
      ctx.shadowBlur = 14
      ctx.fillText(displayName, canvas.width / 2, canvas.height / 2)
    }
    return makeTexture(canvas)
  }

  /**
   * 由 Canvas 创建不带 mipmap 的纹理（省内存与上传耗时）
   */
  function makeTexture(canvas: HTMLCanvasElement): CanvasTexture {
    const tex = new CanvasTexture(canvas)
    tex.colorSpace = SRGBColorSpace
    tex.generateMipmaps = false
    tex.minFilter = LinearFilter
    return tex
  }

  /**
   * 构建单环网格几何体
   */
  function createRingGeometry(layout: RingLayoutResult, ringIndex: number): BufferGeometry {
    const ring = layout.rings[ringIndex]
    const { columns, rows } = calcAtlasGrid(layout.totalSlots)
    const positions: number[] = []
    const uvs: number[] = []

    const halfH = RING_HEIGHT / 2
    for (const slot of ring.slots) {
      const thetaCenter = (slot.slotIndex / SLOTS_PER_RING) * Math.PI * 2
      const halfSpan = (Math.PI / SLOTS_PER_RING) * 0.96
      const t0 = thetaCenter - halfSpan
      const t1 = thetaCenter + halfSpan

      const x0 = CYLINDER_RADIUS * Math.sin(t0)
      const z0 = CYLINDER_RADIUS * Math.cos(t0)
      const x1 = CYLINDER_RADIUS * Math.sin(t1)
      const z1 = CYLINDER_RADIUS * Math.cos(t1)

      const uv = calcAtlasUv(slot.globalIndex, columns, rows)

      // 三角形 1: 左上 -> 左下 -> 右上
      positions.push(x0, halfH, z0, x0, -halfH, z0, x1, halfH, z1)
      uvs.push(uv.uMin, uv.vMax, uv.uMin, uv.vMin, uv.uMax, uv.vMax)

      // 三角形 2: 右上 -> 左下 -> 右下
      positions.push(x1, halfH, z1, x0, -halfH, z0, x1, -halfH, z1)
      uvs.push(uv.uMax, uv.vMax, uv.uMin, uv.vMin, uv.uMax, uv.vMin)
    }

    const geo = new BufferGeometry()
    geo.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
    return geo
  }

  /**
   * 按名单构建文字图集、材质与各环网格（play 与 preview 共用），返回主题色
   */
  function buildCylinder(names: readonly string[], winner: string, highlight: boolean, carry: readonly number[]): string {
    const primaryColor = readPrimaryColor(container)
    const layout = buildRingLayout(names, winner)

    // 构建文字图集与材质
    const atlasCanvas = buildAtlasCanvas(layout, primaryColor, highlight)
    atlasCanvasRef = atlasCanvas
    atlasTexture = makeTexture(atlasCanvas)

    ringMaterial = new MeshBasicMaterial({
      map: atlasTexture,
      transparent: true,
      opacity: 1.0,
      depthTest: false,
      depthWrite: false,
    })

    // 构建各环网格
    for (let r = 0; r < layout.ringCount; r++) {
      const geo = createRingGeometry(layout, r)
      const mesh = new Mesh(geo, ringMaterial)
      const yOffset = (r - layout.targetRingIndex) * (RING_HEIGHT + RING_GAP)
      mesh.position.y = yOffset

      const motion = calcRingMotion(r, layout.ringCount, layout.targetRingIndex, targetRounds)
      const isTarget = r === layout.targetRingIndex
      const targetSlot = isTarget ? layout.targetSlotIndex : Math.floor(Math.random() * SLOTS_PER_RING)
      const targetAngle = calcStopAngle(targetSlot, SLOTS_PER_RING, motion.extraRounds, motion.direction)

      const start = carry[r] ?? 0
    mesh.rotation.y = start
      cylinderGroup.add(mesh)
      rings.push({ mesh, geometry: geo, motion, targetAngle, startAngle: start, stopFrom: start, stopTo: targetAngle })
    }
    return primaryColor
  }

  /**
   * 触发粒子爆发
   */
  function triggerParticles(primaryColor: string): void {
    if (particleState) {
      scene.remove(particleState.points)
      particleState.points.geometry.dispose()
      particleState.points.material.dispose()
      particleState = null
    }

    const positions = new Float32Array(PARTICLE_COUNT * 3)
    const velocities = new Float32Array(PARTICLE_COUNT * 3)

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      positions[i * 3] = 0
      positions[i * 3 + 1] = 0
      positions[i * 3 + 2] = CYLINDER_RADIUS + 0.3

      const angle = Math.random() * Math.PI * 2
      const speed = 0.8 + Math.random() * 2.2
      velocities[i * 3] = Math.cos(angle) * speed
      velocities[i * 3 + 1] = Math.sin(angle) * speed + 0.4
      velocities[i * 3 + 2] = (Math.random() - 0.2) * 1.5
    }

    const geo = new BufferGeometry()
    geo.setAttribute('position', new Float32BufferAttribute(positions, 3))
    const mat = new PointsMaterial({
      color: new Color(primaryColor),
      size: 0.12,
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
      depthTest: false,
    })
    const points = new Points(geo, mat)
    points.renderOrder = ORDER_PARTICLES
    lastParticleTime = 0
    scene.add(points)
    particleState = { points, velocities, startTime: performance.now() }
  }

  /**
   * 渲染与动效主循环
   */
  function renderLoop(time: number): void {
    frameQueued = false
    if (hidden) return
    // 时间戳节流：动画/拖动/惯性约 30fps，空闲慢转约 15fps；未到点直接跳过渲染
    if (!shouldRenderFrame(time, lastRenderTime, isIdleOnly() ? IDLE_FRAME_MS : ACTIVE_FRAME_MS)) {
      requestFrame()
      return
    }
    lastRenderTime = time
    let busy = false
    if (isRolling) {
      busy = true
      const freeSpin = manual && stopStartTime === 0
      const progress = freeSpin
        ? 0
        : manual
          ? Math.min(1.0, Math.max(0, time - stopStartTime) / MANUAL_STOP_MS)
          : Math.min(1.0, (time - startTime) / animMs)

      // 转动期间节流轻震
      if (time - lastVibrateTime > VIBRATE_INTERVAL_MS && progress < 0.95) {
        lastVibrateTime = time
        void vibrate(VIBRATE_TICK_MS)
      }

      // 更新各环旋转角度
      for (const r of rings) {
        if (freeSpin) {
          r.mesh.rotation.y = r.startAngle + calcSpinAngle(time - startTime, r.motion.direction, spinRad)
        } else if (manual) {
          const local = Math.min(1, progress / r.motion.stopRatio)
          r.mesh.rotation.y = r.stopFrom + (r.stopTo - r.stopFrom) * easeOutCubic(local)
        } else if (progress < r.motion.stopRatio) {
          const localT = easeOutCubic(progress / r.motion.stopRatio)
          r.mesh.rotation.y = calcApproachAngle(r.startAngle, r.targetAngle, localT)
        } else {
          r.mesh.rotation.y = r.targetAngle
        }
      }

      // 动画到达终点
      if (!freeSpin && progress >= 1.0) {
        isRolling = false
        // 停下重震
        void vibrate(VIBRATE_HEAVY_PATTERN)
        // 落定后先停顿：转子保持清晰，名字暂不弹出
        settleStartTime = time

        if (finishCallback) {
          const cb = finishCallback
          finishCallback = null
          cb()
        }
      }
    }

    // 更新弹出缩放
    if (winnerMesh && winnerMesh.visible && popStartTime > 0) {
      const popT = Math.min(1.0, (time - popStartTime) / POP_DURATION_MS)
      if (popT < 1.0) busy = true
      else popStartTime = 0
      const scale = 1.0 + easeOutCubic(popT) * (WINNER_POP_SCALE - 1)
      winnerMesh.scale.set(scale, scale, 1)
      winnerMesh.position.z = WINNER_BASE_Z + popT * (WINNER_POP_Z - WINNER_BASE_Z)
    }

    // 结算：停顿到点后弹出名字、转子变暗虚化并开始慢转
    if (settleStartTime > 0 && !isRolling) {
      if (time - settleStartTime >= SETTLE_HOLD_MS) {
        settleStartTime = 0
        popStartTime = time
        revealWinner(true)
        busy = true
      } else {
        busy = true
      }
    }

    // 静止态：转子持续缓慢转动（拖动期间暂停自转），松手后惯性叠加衰减，直到下次开抽
    if (((settled && winnerMesh) || previewing) && !paused && !isRolling && !dragLocked) {
      const slowDt = lastSlowTime > 0 ? time - lastSlowTime : 0
      let extra = 0
      if (inertiaVelocity !== 0) {
        const step = calcInertiaStep(inertiaVelocity, slowDt)
        extra = step.delta
        inertiaVelocity = step.velocity
      }
      for (const r of rings) r.mesh.rotation.y += r.motion.direction * (slowRad * slowDt + extra)
      lastSlowTime = time
      busy = true
    } else {
      lastSlowTime = 0
    }

    // 更新粒子运动
    if (particleState) {
      busy = true
      const pElapsed = time - particleState.startTime
      const pProgress = pElapsed / PARTICLE_LIFETIME_MS
      if (pProgress >= 1.0) {
        scene.remove(particleState.points)
        particleState.points.geometry.dispose()
        particleState.points.material.dispose()
        particleState = null
      } else {
        const positions = particleState.points.geometry.attributes.position.array as Float32Array
        const dt = lastParticleTime > 0 ? Math.min((time - lastParticleTime) / 1000, 0.1) : PARTICLE_BASE_DT
        const damp = Math.pow(PARTICLE_DAMPING, dt / PARTICLE_BASE_DT)
        for (let i = 0; i < PARTICLE_COUNT; i++) {
          positions[i * 3] += particleState.velocities[i * 3] * dt
          positions[i * 3 + 1] += particleState.velocities[i * 3 + 1] * dt
          positions[i * 3 + 2] += particleState.velocities[i * 3 + 2] * dt
          // 速度阻尼衰减
          particleState.velocities[i * 3] *= damp
          particleState.velocities[i * 3 + 1] *= damp
          particleState.velocities[i * 3 + 2] *= damp
        }
        particleState.points.geometry.attributes.position.needsUpdate = true
        particleState.points.material.opacity = 1.0 - pProgress
        lastParticleTime = time
      }
    }

    renderer.render(scene, camera)
    if (busy) requestFrame(isIdleOnly() ? Math.max(0, IDLE_FRAME_MS - 2 * FRAME_TOLERANCE_MS) : 0)
  }

  /**
   * 预生成并上传结算用的模糊图集纹理（已有则跳过）
   */
  function prepareBlur(): void {
    if (!blurTexture && atlasCanvasRef) {
      const canvas = document.createElement('canvas')
      canvas.width = atlasCanvasRef.width
      canvas.height = atlasCanvasRef.height
      const ctx = canvas.getContext('2d')
      if (ctx && 'filter' in ctx && blurPx > 0) {
        ctx.filter = `blur(${blurPx}px)`
        ctx.drawImage(atlasCanvasRef, 0, 0)
        blurTexture = makeTexture(canvas)
        renderer.initTexture(blurTexture)
      }
    }
  }

  /**
   * 转子变暗并换上模糊图集（不支持 ctx.filter 时只变暗）
   */
  function dimRings(): void {
    if (!ringMaterial) return
    ringMaterial.opacity = RING_DIM_OPACITY
    prepareBlur()
    if (blurTexture) {
      ringMaterial.map = blurTexture
      ringMaterial.needsUpdate = true
    }
  }

  /**
   * 生成中奖者弹出卡片（初始隐藏）；已生成或无待生成项时直接返回
   */
  function ensureWinner(): void {
    const pending = pendingWinner
    if (!pending || winnerMesh) return
    pendingWinner = null
    winnerTexture = buildWinnerTexture(pending.name, pending.color)
    renderer.initTexture(winnerTexture)
    const winnerGeo = new BufferGeometry()
    const hw = WINNER_PLANE_W / 2
    const hh = WINNER_PLANE_H / 2
    // 面向 +Z
    const pos = [-hw, hh, 0, -hw, -hh, 0, hw, hh, 0, hw, hh, 0, -hw, -hh, 0, hw, -hh, 0]
    const uv = [0, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 0]
    winnerGeo.setAttribute('position', new Float32BufferAttribute(pos, 3))
    winnerGeo.setAttribute('uv', new Float32BufferAttribute(uv, 2))
    const winnerMat = new MeshBasicMaterial({
      map: winnerTexture,
      transparent: true,
      opacity: 1.0,
      depthTest: false,
      depthWrite: false,
    })
    winnerMesh = new Mesh(winnerGeo, winnerMat)
    winnerMesh.renderOrder = ORDER_WINNER
    winnerMesh.position.set(0, 0, WINNER_BASE_Z)
    winnerMesh.visible = false
    scene.add(winnerMesh)
  }

  /**
   * 揭晓中奖者：显示名字、转子变暗虚化、进入慢转；animate 为 true 时附带粒子爆发
   */
  function revealWinner(animate: boolean): void {
    ensureWinner()
    if (winnerMesh) {
      winnerMesh.visible = true
      if (!animate) {
        winnerMesh.scale.set(WINNER_POP_SCALE, WINNER_POP_SCALE, 1)
        winnerMesh.position.z = WINNER_POP_Z
      }
    }
    dimRings()
    if (animate) triggerParticles(readPrimaryColor(container))
    enterSettled()
  }

  /**
   * 进入静止态：开始持续慢转（下一帧起生效）
   */
  function enterSettled(): void {
    settled = true
    requestFrame()
  }

  /**
   * 清除上一轮的滚筒网格与纹理
   */
  function clearRings(): void {
    settled = false
    previewing = false
    endDragState()
    inertiaVelocity = 0
    lastParticleTime = 0
    paused = false
    settleStartTime = 0
    popStartTime = 0
    lastSlowTime = 0
    cylinderGroup.visible = true
    for (const r of rings) {
      cylinderGroup.remove(r.mesh)
      r.geometry.dispose()
    }
    rings = []

    if (atlasTexture) {
      atlasTexture.dispose()
      atlasTexture = null
    }
    if (blurTexture) {
      blurTexture.dispose()
      blurTexture = null
    }
    atlasCanvasRef = null
    pendingWinner = null
    if (ringMaterial) {
      ringMaterial.dispose()
      ringMaterial = null
    }
    if (winnerMesh) {
      scene.remove(winnerMesh)
      winnerMesh.geometry.dispose()
      winnerMesh.material.dispose()
      winnerMesh = null
    }
    if (winnerTexture) {
      winnerTexture.dispose()
      winnerTexture = null
    }
    if (particleState) {
      scene.remove(particleState.points)
      particleState.points.geometry.dispose()
      particleState.points.material.dispose()
      particleState = null
    }
  }

  return {
    play(names: readonly string[], winner: string, onFinish?: () => void, opts?: PlayOptions) {
      // 带上当前慢转角度，开抽时平滑衔接
      const carry = rings.map((x) => normalizeAngle(x.mesh.rotation.y))
      clearRings()
      manual = !!opts?.manual
      animMs = opts?.durationMs ?? STAGE_ANIM_MS
      if (opts?.spinRps) spinRad = rpsToRadPerMs(opts.spinRps)
      targetRounds = manual || !opts?.spinRps ? DEFAULT_TARGET_ROUNDS : calcTargetRounds(opts.spinRps, animMs)
      stopStartTime = 0
      currentWinner = winner
      finishCallback = onFinish ?? null

      const primaryColor = buildCylinder(names, winner, true, carry)

      // 中奖者卡片纹理较重，错峰到转动中生成（揭晓前保证已就绪）
      pendingWinner = { name: winner, color: primaryColor }
      const pendingAtPlay = pendingWinner
      // 转动中错峰预生成模糊图集，结算时直接换图
      const atlasAtPlay = atlasCanvasRef
      window.setTimeout(() => {
        if (disposed || pendingWinner !== pendingAtPlay) return
        ensureWinner()
        if (atlasCanvasRef === atlasAtPlay) prepareBlur()
      }, BLUR_PREPARE_DELAY_MS)

      // 开始动画
      startTime = performance.now()
      lastVibrateTime = startTime
      isRolling = true
      requestFrame()
    },

    preview(names: readonly string[]) {
      if (isRolling || settleStartTime > 0 || !names.length) return
      const carry = rings.map((x) => normalizeAngle(x.mesh.rotation.y))
      clearRings()
      manual = false
      buildCylinder(names, names[0], false, carry)
      previewing = true
      requestFrame()
    },

    clear() {
      if (isRolling || settleStartTime > 0) return
      clearRings()
      renderer.render(scene, camera)
    },

    stop() {
      if (!manual || !isRolling || stopStartTime > 0) return
      const now = performance.now()
      stopStartTime = now
      for (const r of rings) {
        r.stopFrom = r.startAngle + calcSpinAngle(now - startTime, r.motion.direction, spinRad)
        r.stopTo = calcStopTarget(r.stopFrom, r.targetAngle, r.motion.direction, MANUAL_STOP_MS * r.motion.stopRatio, spinRad)
      }
      requestFrame()
    },

    configure(cfg) {
      slowRad = rpmToRadPerMs(cfg.idleRpm)
      if (cfg.blurPx === blurPx) return
      blurPx = cfg.blurPx
      // 已虚化时重建模糊图集，改动立即可见
      const dimmed = !!ringMaterial && ringMaterial.opacity === RING_DIM_OPACITY
      if (blurTexture) {
        blurTexture.dispose()
        blurTexture = null
      }
      if (dimmed) {
        if (ringMaterial && atlasTexture) ringMaterial.map = atlasTexture
        dimRings()
        requestFrame()
      }
    },

    settleNow() {
      const wasRolling = isRolling
      if (!wasRolling && settleStartTime === 0) return
      isRolling = false
      void cancelVibrate()

      // 直接跳到结算终态：转子隐藏，中奖者保持原位
      for (const r of rings) {
        r.mesh.rotation.y = r.targetAngle
      }
      settleStartTime = 0
      popStartTime = 0
      revealWinner(false)
      if (finishCallback) {
        const cb = finishCallback
        finishCallback = null
        cb()
      }
    },

    setPaused(value: boolean) {
      paused = value
      if (value) endDragState()
      else if (settled || previewing) {
        lastSlowTime = 0
        requestFrame()
      }
    },

    dispose() {
      disposed = true
      cancelAnimationFrame(animFrameId)
      clearTimeout(idleTimerId)
      document.removeEventListener('visibilitychange', onVisibility)
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('pointermove', onPointerMove)
      container.removeEventListener('pointerup', onPointerEnd)
      container.removeEventListener('pointercancel', onPointerEnd)
      container.style.touchAction = ''
      void cancelVibrate()
      resizeObserver.disconnect()
      clearRings()

      scene.remove(cylinderGroup)

      renderer.dispose()
      renderer.forceContextLoss()
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement)
      }
    },
  }
}
