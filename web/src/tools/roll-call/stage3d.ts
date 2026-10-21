/**
 * 随机点名 3D 滚筒舞台渲染器：基于 Three.js 实现多环圆柱、图集文本合批、旋转刹停、弹出高亮与粒子爆发。
 */
import {
  AmbientLight,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
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
  calcStopAngle,
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

/** 粒子爆发总数 */
const PARTICLE_COUNT = 120
/** 粒子消散时长（毫秒） */
const PARTICLE_LIFETIME_MS = 800
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
}

/**
 * 粒子运行时状态
 */
interface ParticleState {
  points: Points<BufferGeometry, PointsMaterial>
  velocities: Float32Array
  startTime: number
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
   */
  play: (names: readonly string[], winner: string, onFinish?: () => void) => void
  /**
   * 立即跳到结算结果并结束动画。
   */
  settleNow: () => void
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

  const renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(container.clientWidth || 300, container.clientHeight || 180)
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.pointerEvents = 'none'
  container.appendChild(renderer.domElement)

  const ambientLight = new AmbientLight(0xffffff, 1.2)
  scene.add(ambientLight)
  const dirLight = new DirectionalLight(0xffffff, 0.8)
  dirLight.position.set(0, 3, 5)
  scene.add(dirLight)

  const cylinderGroup = new Group()
  scene.add(cylinderGroup)

  let atlasTexture: CanvasTexture | null = null
  let ringMaterial: MeshBasicMaterial | null = null
  let rings: RingRuntime[] = []
  let winnerMesh: Mesh<BufferGeometry, MeshBasicMaterial> | null = null
  let winnerTexture: CanvasTexture | null = null
  let particleState: ParticleState | null = null

  let animFrameId = 0
  let startTime = 0
  let isRolling = false
  let lastVibrateTime = 0
  let finishCallback: (() => void) | null = null
  let currentWinner = ''
  let popStartTime = 0

  /**
   * 监听容器尺寸变化自适应渲染器
   */
  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) {
        camera.aspect = width / height
        camera.updateProjectionMatrix()
        renderer.setSize(width, height)
      }
    }
  })
  resizeObserver.observe(container)

  /**
   * 绘制文字图集 Canvas
   */
  function buildAtlasCanvas(layout: RingLayoutResult, primaryColor: string): HTMLCanvasElement {
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
        ctx.fillStyle = slot.isWinner ? '#ffffff' : '#cfd8ea'
        ctx.shadowColor = slot.isWinner ? primaryColor : 'transparent'
        ctx.shadowBlur = slot.isWinner ? 8 : 0
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
      // 霓虹发光圆角矩形底框
      ctx.fillStyle = 'rgba(15, 18, 28, 0.95)'
      ctx.strokeStyle = primaryColor
      ctx.lineWidth = 4
      ctx.shadowColor = primaryColor
      ctx.shadowBlur = 18

      const rx = 16
      const ry = 16
      const rw = canvas.width - 32
      const rh = canvas.height - 32
      const radius = 18
      ctx.beginPath()
      ctx.roundRect(rx, ry, rw, rh, radius)
      ctx.fill()
      ctx.stroke()

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
    const tex = new CanvasTexture(canvas)
    tex.colorSpace = SRGBColorSpace
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
    geo.computeVertexNormals()
    return geo
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
    })
    const points = new Points(geo, mat)
    scene.add(points)
    particleState = { points, velocities, startTime: performance.now() }
  }

  /**
   * 渲染与动效主循环
   */
  function renderLoop(time: number): void {
    if (isRolling) {
      const elapsed = time - startTime
      const progress = Math.min(1.0, elapsed / STAGE_ANIM_MS)

      // 转动期间节流轻震
      if (time - lastVibrateTime > VIBRATE_INTERVAL_MS && progress < 0.95) {
        lastVibrateTime = time
        void vibrate(VIBRATE_TICK_MS)
      }

      // 更新各环旋转角度
      for (const r of rings) {
        if (progress < r.motion.stopRatio) {
          const localT = easeOutCubic(progress / r.motion.stopRatio)
          r.mesh.rotation.y = localT * r.targetAngle
        } else {
          r.mesh.rotation.y = r.targetAngle
        }
      }

      // 动画到达终点
      if (progress >= 1.0) {
        isRolling = false
        // 停下重震
        void vibrate(VIBRATE_HEAVY_PATTERN)
        popStartTime = performance.now()

        // 其余环渐暗
        if (ringMaterial) {
          ringMaterial.opacity = 0.2
        }

        // 选中名字弹出放大
        if (winnerMesh) {
          winnerMesh.visible = true
        }

        // 粒子爆散
        const primaryColor = readPrimaryColor(container)
        triggerParticles(primaryColor)

        if (finishCallback) {
          const cb = finishCallback
          finishCallback = null
          cb()
        }
      }
    }

    // 更新弹出缩放
    if (winnerMesh && winnerMesh.visible && popStartTime > 0) {
      const popElapsed = performance.now() - popStartTime
      const popT = Math.min(1.0, popElapsed / POP_DURATION_MS)
      const scale = 1.0 + easeOutCubic(popT) * 0.35
      winnerMesh.scale.set(scale, scale, 1)
      winnerMesh.position.z = CYLINDER_RADIUS + 0.3 + popT * 0.2
    }

    // 更新粒子运动
    if (particleState) {
      const pElapsed = performance.now() - particleState.startTime
      const pProgress = pElapsed / PARTICLE_LIFETIME_MS
      if (pProgress >= 1.0) {
        scene.remove(particleState.points)
        particleState.points.geometry.dispose()
        particleState.points.material.dispose()
        particleState = null
      } else {
        const positions = particleState.points.geometry.attributes.position.array as Float32Array
        const dt = 0.016
        for (let i = 0; i < PARTICLE_COUNT; i++) {
          positions[i * 3] += particleState.velocities[i * 3] * dt
          positions[i * 3 + 1] += particleState.velocities[i * 3 + 1] * dt
          positions[i * 3 + 2] += particleState.velocities[i * 3 + 2] * dt
          // 速度阻尼衰减
          particleState.velocities[i * 3] *= 0.95
          particleState.velocities[i * 3 + 1] *= 0.95
          particleState.velocities[i * 3 + 2] *= 0.95
        }
        particleState.points.geometry.attributes.position.needsUpdate = true
        particleState.points.material.opacity = 1.0 - pProgress
      }
    }

    renderer.render(scene, camera)
    animFrameId = requestAnimationFrame(renderLoop)
  }

  // 启动 rAF 渲染循环
  animFrameId = requestAnimationFrame(renderLoop)

  /**
   * 清除上一轮的滚筒网格与纹理
   */
  function clearRings(): void {
    for (const r of rings) {
      cylinderGroup.remove(r.mesh)
      r.geometry.dispose()
    }
    rings = []

    if (atlasTexture) {
      atlasTexture.dispose()
      atlasTexture = null
    }
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
    play(names: readonly string[], winner: string, onFinish?: () => void) {
      clearRings()
      currentWinner = winner
      finishCallback = onFinish ?? null

      const primaryColor = readPrimaryColor(container)
      const layout = buildRingLayout(names, winner)

      // 构建文字图集与材质
      const atlasCanvas = buildAtlasCanvas(layout, primaryColor)
      atlasTexture = new CanvasTexture(atlasCanvas)
      atlasTexture.colorSpace = SRGBColorSpace

      ringMaterial = new MeshBasicMaterial({
        map: atlasTexture,
        transparent: true,
        opacity: 1.0,
      })

      // 构建各环网格
      for (let r = 0; r < layout.ringCount; r++) {
        const geo = createRingGeometry(layout, r)
        const mesh = new Mesh(geo, ringMaterial)
        const yOffset = (r - layout.targetRingIndex) * (RING_HEIGHT + RING_GAP)
        mesh.position.y = yOffset

        const motion = calcRingMotion(r, layout.ringCount, layout.targetRingIndex)
        const isTarget = r === layout.targetRingIndex
        const targetSlot = isTarget ? layout.targetSlotIndex : Math.floor(Math.random() * SLOTS_PER_RING)
        const targetAngle = calcStopAngle(targetSlot, SLOTS_PER_RING, motion.extraRounds, motion.direction)

        mesh.rotation.y = 0
        cylinderGroup.add(mesh)
        rings.push({ mesh, geometry: geo, motion, targetAngle })
      }

      // 构建中奖者弹出高亮 Mesh（初始隐藏）
      winnerTexture = buildWinnerTexture(winner, primaryColor)
      const winnerGeo = new BufferGeometry()
      const planeW = 2.4
      const planeH = 0.75
      const hw = planeW / 2
      const hh = planeH / 2
      // 面向 +Z
      const pos = [-hw, hh, 0, -hw, -hh, 0, hw, hh, 0, hw, hh, 0, -hw, -hh, 0, hw, -hh, 0]
      const uv = [0, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 0]
      winnerGeo.setAttribute('position', new Float32BufferAttribute(pos, 3))
      winnerGeo.setAttribute('uv', new Float32BufferAttribute(uv, 2))

      const winnerMat = new MeshBasicMaterial({
        map: winnerTexture,
        transparent: true,
        opacity: 1.0,
      })
      winnerMesh = new Mesh(winnerGeo, winnerMat)
      winnerMesh.position.set(0, 0, CYLINDER_RADIUS + 0.3)
      winnerMesh.visible = false
      scene.add(winnerMesh)

      // 开始动画
      startTime = performance.now()
      lastVibrateTime = startTime
      isRolling = true
    },

    settleNow() {
      if (!isRolling) return
      isRolling = false
      void cancelVibrate()

      for (const r of rings) {
        r.mesh.rotation.y = r.targetAngle
      }
      if (ringMaterial) {
        ringMaterial.opacity = 0.2
      }
      if (winnerMesh) {
        winnerMesh.visible = true
        winnerMesh.scale.set(1.35, 1.35, 1)
        winnerMesh.position.z = CYLINDER_RADIUS + 0.5
      }
      if (finishCallback) {
        const cb = finishCallback
        finishCallback = null
        cb()
      }
    },

    dispose() {
      cancelAnimationFrame(animFrameId)
      void cancelVibrate()
      resizeObserver.disconnect()
      clearRings()

      scene.remove(cylinderGroup)
      scene.remove(ambientLight)
      scene.remove(dirLight)
      ambientLight.dispose()
      dirLight.dispose()

      renderer.dispose()
      renderer.forceContextLoss()
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement)
      }
    },
  }
}
