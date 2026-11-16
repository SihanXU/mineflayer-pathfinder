const { performance } = require('perf_hooks')

const AStar = require('./lib/astar')
const Move = require('./lib/move')
const Movements = require('./lib/movements')
const gotoUtil = require('./lib/goto')
const Lock = require('./lib/lock')

const Vec3 = require('vec3').Vec3

const Physics = require('./lib/physics')
const nbt = require('prismarine-nbt')
const interactableBlocks = require('./lib/interactable.json')

function inject (bot) {
  const ladderId = bot.registry.blocksByName.ladder.id
  const vineId = bot.registry.blocksByName.vine.id
  let stateMovements = new Movements(bot)
  let stateGoal = null
  let astarContext = null
  let astartTimedout = false
  let dynamicGoal = false
  let path = []
  let pathRevision = 0
  let pathUpdated = false
  // The ticks in a row a due search has waited for the body to land, and the most it waits.
  let airTicks = 0
  const AIR_TICKS = 30
  // How long a block placed under a jump is waited for: a jump lasts 12 ticks (600 ms).
  const JUMP_PLACE_MS = 700
  // While the body has a path to go on by, a search's result that is not its last (the search
  // goes on) is not used for the search's first SEARCH_HEAD_MS; its last result is used at once,
  // and so is any result when there is no path to go on by. Until then the body goes on by the
  // path it had, where the world changed (a block near the path, a chunk loaded) or the goal
  // moved: most changes of blocks are the path's own digs and placements, which it was planned
  // with, and a goal that moved is still where the old path leads, nearly. The first
  // slices of a search give the way to the point nearest the goal in a straight line, which is
  // often the opposite of the way that is found in the end (a block placed under a jump was dug
  // out again by the first slice of the next search, then placed again, without end).
  const SEARCH_HEAD_MS = 500
  let found = null // the newest result of a search that is not in use yet
  let useAt = 0 // when it is put to use
  let searchDue = false // the path is kept and a new search has to start
  let walkedOn = false // the body went on by a path while the search of `found` ran
  let diggingAt = null // the block being dug
  let digDropped = false // that dig was ended for a new path: its failure drops no path
  let digging = false
  let placing = false
  let placingBlock = null
  let lastNodeTime = performance.now()
  let returningPos = null
  let stopPathing = false
  const physics = new Physics(bot)
  const lockPlaceBlock = new Lock()
  const lockEquipItem = new Lock()
  const lockUseBlock = new Lock()

  bot.pathfinder = {}

  bot.pathfinder.thinkTimeout = 5000 // ms
  bot.pathfinder.tickTimeout = 40 // ms, amount of thinking per tick (max 50 ms)
  bot.pathfinder.searchRadius = -1 // in blocks, limits of the search area, -1: don't limit the search
  bot.pathfinder.enablePathShortcut = false // disabled by default as it can cause bugs in specific configurations
  bot.pathfinder.LOSWhenPlacingBlocks = true

  bot.pathfinder.bestHarvestTool = (block) => {
    const availableTools = bot.inventory.items()
    const effects = bot.entity.effects

    let fastest = Number.MAX_VALUE
    let bestTool = null
    for (const tool of availableTools) {
      const enchants = (tool && tool.nbt) ? nbt.simplify(tool.nbt).Enchantments : []
      const digTime = block.digTime(tool ? tool.type : null, false, false, false, enchants, effects)
      if (digTime < fastest) {
        fastest = digTime
        bestTool = tool
      }
    }

    return bestTool
  }

  bot.pathfinder.getPathTo = (movements, goal, timeout) => {
    const generator = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, { timeout })
    const { value: { result, astarContext: context } } = generator.next()
    astarContext = context
    return result
  }

  bot.pathfinder.getPathFromTo = function * (movements, startPos, goal, options = {}) {
    const optimizePath = options.optimizePath ?? true
    const resetEntityIntersects = options.resetEntityIntersects ?? true
    const timeout = options.timeout ?? bot.pathfinder.thinkTimeout
    const tickTimeout = options.tickTimeout ?? bot.pathfinder.tickTimeout
    const searchRadius = options.searchRadius ?? bot.pathfinder.searchRadius
    let start
    if (options.startMove) {
      start = options.startMove
    } else {
      const p = startPos.floored()
      const dy = startPos.y - p.y
      const b = bot.blockAt(p) // The block we are standing in
      // Offset the floored bot position by one if we are standing on a block that has not the full height but is solid
      const offset = (b && dy > 0.001 && bot.entity.onGround && !stateMovements.emptyBlocks.has(b.type)) ? 1 : 0
      start = new Move(p.x, p.y + offset, p.z, movements.countScaffoldingItems(), 0)
    }
    if (movements.allowEntityDetection) {
      if (resetEntityIntersects) {
        movements.clearCollisionIndex()
      }
      movements.updateCollisionIndex()
    }
    const astarContext = new AStar(start, movements, goal, timeout, tickTimeout, searchRadius)
    let result = astarContext.compute()
    if (optimizePath) result.path = postProcessPath(result.path)
    yield { result, astarContext }
    while (result.status === 'partial') {
      result = astarContext.compute()
      if (optimizePath) result.path = postProcessPath(result.path)
      yield { result, astarContext }
    }
  }

  Object.defineProperties(bot.pathfinder, {
    goal: {
      get () {
        return stateGoal
      }
    },
    movements: {
      get () {
        return stateMovements
      }
    }
  })

  function detectDiggingStopped () {
    digging = false
    bot.removeAllListeners('diggingAborted', detectDiggingStopped)
    bot.removeAllListeners('diggingCompleted', detectDiggingStopped)
  }

  function resetPath (reason, clearStates = true) {
    pathRevision++
    if (!stopPathing && path.length > 0) bot.emit('path_reset', reason)
    found = null
    if ((reason === 'block_updated' || reason === 'chunk_loaded' || reason === 'goal_moved') && path.length > 0 && !stopPathing) {
      // the world changed or the goal moved: the path stays in use until the new search's result is
      searchDue = true
      pathUpdated = false
      astarContext = null
      return
    }
    searchDue = false
    path = []
    if (digging) {
      bot.on('diggingAborted', detectDiggingStopped)
      bot.on('diggingCompleted', detectDiggingStopped)
      bot.stopDigging()
    }
    placing = false
    pathUpdated = false
    astarContext = null
    lockEquipItem.release()
    lockPlaceBlock.release()
    lockUseBlock.release()
    stateMovements.clearCollisionIndex()
    if (clearStates) bot.clearControlStates()
    if (stopPathing) return stop()
  }

  bot.pathfinder.setGoal = (goal, dynamic = false) => {
    stateGoal = goal
    dynamicGoal = dynamic
    bot.emit('goal_updated', goal, dynamic)
    resetPath('goal_updated')
  }

  bot.pathfinder.setMovements = (movements) => {
    stateMovements = movements
    resetPath('movements_updated')
  }

  bot.pathfinder.isMoving = () => path.length > 0
  bot.pathfinder.isMining = () => digging
  bot.pathfinder.isBuilding = () => placing

  bot.pathfinder.goto = (goal) => {
    return gotoUtil(bot, goal)
  }

  bot.pathfinder.stop = () => {
    // Nothing is running, so there is nothing to stop; the flag would otherwise survive until the
    // next goal and stop that one instead.
    if (!stateGoal && path.length === 0) return
    stopPathing = true
  }

  bot.on('physicsTick', monitorMovement)

  function postProcessPath (path) {
    for (let i = 0; i < path.length; i++) {
      const curPoint = path[i]
      // A useOne (open a gate/door on the way through) is a click, not a placement:
      // it must not stop the pass, or this node and every one after it keep their
      // raw corner coordinates and the executor steers into the frame
      if (curPoint.toBreak.length > 0 || curPoint.toPlace.some(p => !p.useOne)) break
      const b = bot.blockAt(new Vec3(curPoint.x, curPoint.y, curPoint.z))
      // An openable block is a doorway: its node is the floor centre. getPositionOnTopOf
      // would put it on top of the swung-open leaf (offset ~0.9 and a block up), which
      // the walk simulation can never reach — the bot stands in the open doorway until 'stuck'
      const doorway = stateMovements && stateMovements.openable && b && stateMovements.openable.has(b.type)
      const liquid = b && b.boundingBox === 'empty' && (stateMovements.liquids.has(b.type) || b.isWaterlogged === true)
      if (b && (liquid || doorway || ((b.type === ladderId || b.type === vineId) && i + 1 < path.length && path[i + 1].y < curPoint.y))) {
        curPoint.x = Math.floor(curPoint.x) + 0.5
        curPoint.y = Math.floor(curPoint.y)
        curPoint.z = Math.floor(curPoint.z) + 0.5
        continue
      }
      let np = getPositionOnTopOf(b)
      if (np === null) np = getPositionOnTopOf(bot.blockAt(new Vec3(curPoint.x, curPoint.y - 1, curPoint.z)))
      if (np) {
        curPoint.x = np.x
        curPoint.y = np.y
        curPoint.z = np.z
      } else {
        curPoint.x = Math.floor(curPoint.x) + 0.5
        curPoint.y = curPoint.y - 1
        curPoint.z = Math.floor(curPoint.z) + 0.5
      }
    }

    if (!bot.pathfinder.enablePathShortcut || stateMovements.exclusionAreasStep.length !== 0 || path.length === 0) return path

    const newPath = []
    let lastNode = bot.entity.position
    for (let i = 1; i < path.length; i++) {
      const node = path[i]
      if (Math.abs(node.y - lastNode.y) > 0.5 || node.toBreak.length > 0 || node.toPlace.length > 0 || !physics.canStraightLineBetween(lastNode, node)) {
        newPath.push(path[i - 1])
        lastNode = path[i - 1]
      }
    }
    newPath.push(path[path.length - 1])
    return newPath
  }

  function pathFromPlayer (path) {
    if (path.length === 0) return
    let minI = 0
    let minDistance = 1000
    for (let i = 0; i < path.length; i++) {
      const node = path[i]
      if (node.toBreak.length !== 0 || node.toPlace.length !== 0) break
      const dist = bot.entity.position.distanceSquared(node)
      if (dist < minDistance) {
        minDistance = dist
        minI = i
      }
    }
    // check if we are between 2 nodes
    const n1 = path[minI]
    // check if node already reached
    const dx = n1.x - bot.entity.position.x
    const dy = n1.y - bot.entity.position.y
    const dz = n1.z - bot.entity.position.z
    const reached = Math.abs(dx) <= 0.35 && Math.abs(dz) <= 0.35 && Math.abs(dy) < 1
    if (minI + 1 < path.length && n1.toBreak.length === 0 && n1.toPlace.length === 0) {
      const n2 = path[minI + 1]
      const d2 = bot.entity.position.distanceSquared(n2)
      const d12 = n1.distanceSquared(n2)
      minI += d12 > d2 || reached ? 1 : 0
    }

    path.splice(0, minI)
  }

  function isPositionNearPath (pos, path) {
    let prevNode = null
    for (const node of path) {
      let comparisonPoint = null
      if (
        prevNode === null ||
        (
          Math.abs(prevNode.x - node.x) <= 2 &&
          Math.abs(prevNode.y - node.y) <= 2 &&
          Math.abs(prevNode.z - node.z) <= 2
        )
      ) {
        // Unoptimized path, or close enough to last point
        // to just check against the current point
        comparisonPoint = node
      } else {
        // Optimized path - the points are far enough apart
        //   that we need to check the space between them too

        // First, a quick check - if point it outside the path
        // segment's AABB, then it isn't near.
        const minBound = prevNode.min(node)
        const maxBound = prevNode.max(node)
        if (
          pos.x - 0.5 < minBound.x - 1 ||
          pos.x - 0.5 > maxBound.x + 1 ||
          pos.y - 0.5 < minBound.y - 2 ||
          pos.y - 0.5 > maxBound.y + 2 ||
          pos.z - 0.5 < minBound.z - 1 ||
          pos.z - 0.5 > maxBound.z + 1
        ) {
          continue
        }

        comparisonPoint = closestPointOnLineSegment(pos, prevNode, node)
      }

      const dx = Math.abs(comparisonPoint.x - pos.x - 0.5)
      const dy = Math.abs(comparisonPoint.y - pos.y - 0.5)
      const dz = Math.abs(comparisonPoint.z - pos.z - 0.5)
      if (dx <= 1 && dy <= 2 && dz <= 1) return true

      prevNode = node
    }

    return false
  }

  function closestPointOnLineSegment (point, segmentStart, segmentEnd) {
    const segmentLength = segmentEnd.minus(segmentStart).norm()

    if (segmentLength === 0) {
      return segmentStart
    }

    // t is like an interpolation from segmentStart to segmentEnd
    //  for the closest point on the line
    let t = (point.minus(segmentStart)).dot(segmentEnd.minus(segmentStart)) / segmentLength

    // bound t to be on the segment
    t = Math.max(0, Math.min(1, t))

    return segmentStart.plus(segmentEnd.minus(segmentStart).scaled(t))
  }

  // Return the average x/z position of the highest standing positions
  // in the block.
  function getPositionOnTopOf (block) {
    if (!block || block.shapes.length === 0) return null
    const p = new Vec3(0.5, 0, 0.5)
    let n = 1
    for (const shape of block.shapes) {
      const h = shape[4]
      if (h === p.y) {
        p.x += (shape[0] + shape[3]) / 2
        p.z += (shape[2] + shape[5]) / 2
        n++
      } else if (h > p.y) {
        n = 2
        p.x = 0.5 + (shape[0] + shape[3]) / 2
        p.y = h
        p.z = 0.5 + (shape[2] + shape[5]) / 2
      }
    }
    p.x /= n
    p.z /= n
    return block.position.plus(p)
  }

  /**
   * Stop the bot's movement and recenter to the center off the block when the bot's hitbox is partially beyond the
   * current blocks dimensions.
   */
  function fullStop () {
    bot.clearControlStates()

    // Force horizontal velocity to 0 (otherwise inertia can move us too far)
    // Kind of cheaty, but the server will not tell the difference
    bot.entity.velocity.x = 0
    bot.entity.velocity.z = 0

    const blockX = Math.floor(bot.entity.position.x) + 0.5
    const blockZ = Math.floor(bot.entity.position.z) + 0.5

    // Make sure our bounding box don't collide with neighboring blocks
    // otherwise recenter the position
    if (Math.abs(bot.entity.position.x - blockX) > 0.2) { bot.entity.position.x = blockX }
    if (Math.abs(bot.entity.position.z - blockZ) > 0.2) { bot.entity.position.z = blockZ }
  }

  function moveToEdge (refBlock, edge) {
    // If allowed turn instantly should maybe be a bot option
    const allowInstantTurn = false
    function getViewVector (pitch, yaw) {
      const csPitch = Math.cos(pitch)
      const snPitch = Math.sin(pitch)
      const csYaw = Math.cos(yaw)
      const snYaw = Math.sin(yaw)
      return new Vec3(-snYaw * csPitch, snPitch, -csYaw * csPitch)
    }
    // Target viewing direction while approaching edge
    // The Bot approaches the edge while looking in the opposite direction from where it needs to go
    // The target Pitch angle is roughly the angle the bot has to look down for when it is in the position
    // to place the next block
    const targetBlockPos = refBlock.offset(edge.x + 0.5, edge.y, edge.z + 0.5)
    const targetPosDelta = bot.entity.position.clone().subtract(targetBlockPos)
    const targetYaw = Math.atan2(-targetPosDelta.x, -targetPosDelta.z)
    const targetPitch = -1.421
    const viewVector = getViewVector(targetPitch, targetYaw)
    // While the bot is not in the right position rotate the view and press back while crouching
    if (bot.entity.position.distanceTo(refBlock.clone().offset(edge.x + 0.5, 1, edge.z + 0.5)) > 0.4) {
      bot.lookAt(bot.entity.position.offset(viewVector.x, viewVector.y, viewVector.z), allowInstantTurn)
      bot.setControlState('sneak', true)
      bot.setControlState('back', true)
      return false
    }
    bot.setControlState('back', false)
    return true
  }

  function moveToBlock (pos) {
    // minDistanceSq = Min distance sqrt to the target pos were the bot is centered enough to place blocks around him
    const minDistanceSq = 0.2 * 0.2
    const targetPos = pos.clone().offset(0.5, 0, 0.5)
    if (bot.entity.position.distanceSquared(targetPos) > minDistanceSq) {
      bot.lookAt(targetPos)
      bot.setControlState('forward', true)
      return false
    }
    bot.setControlState('forward', false)
    return true
  }

  function stop () {
    pathRevision++
    stopPathing = false
    stateGoal = null
    found = null
    searchDue = false
    path = []
    bot.emit('path_stop')
    fullStop()
  }

  bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (!oldBlock || !newBlock) return
    if (isPositionNearPath(oldBlock.position, path) && oldBlock.type !== newBlock.type) {
      resetPath('block_updated', false)
    }
  })

  bot.on('chunkColumnLoad', (chunk) => {
    // Reset only if the new chunk is adjacent to a visited chunk
    if (astarContext) {
      const cx = chunk.x >> 4
      const cz = chunk.z >> 4
      if (astarContext.visitedChunks.has(`${cx - 1},${cz}`) ||
          astarContext.visitedChunks.has(`${cx},${cz - 1}`) ||
          astarContext.visitedChunks.has(`${cx + 1},${cz}`) ||
          astarContext.visitedChunks.has(`${cx},${cz + 1}`)) {
        resetPath('chunk_loaded', false)
      }
    }
  })

  function inTheAir () {
    const e = bot.entity
    if (e.onGround || e.isInWater || e.isInLava || e.elytraFlying) return false
    const b = bot.blockAt(e.position)
    return !(b && (b.type === ladderId || b.type === vineId))
  }

  // In water the body bobs: with jump held it rises and sinks around the surface, and on the
  // tick it crosses the middle of a cell it can be more than 0.25 under the step's point, so
  // the step was not counted and the body turned round to swim back to it. A step through
  // water at one height counts as reached once the body is past its point on the way to the
  // step after it, beside the line between the two by no more than half a block.
  function passedInWater (p) {
    if (!bot.entity.isInWater || path.length < 2) return false
    const here = path[0]
    const next = path[1]
    if (here.y !== next.y) return false
    const ux = next.x - here.x
    const uz = next.z - here.z
    const length = Math.hypot(ux, uz)
    if (length === 0) return false
    const rx = p.x - here.x
    const rz = p.z - here.z
    const along = (rx * ux + rz * uz) / length
    const beside = Math.abs(rx * uz - rz * ux) / length
    return along > 0 && beside <= 0.5 && Math.abs(here.y - p.y) < 1
  }

  // The result of the new search replaces the path. What the old path was doing ends, as in a
  // drop of the path, except a dig of the block the new path digs first: that dig goes on.
  function useFound () {
    const results = found
    found = null
    searchDue = false
    // The points the body has passed meanwhile are cut off, where it went on by a path while
    // the search ran. A path the body has not moved since is used whole: cut to the body's
    // place, it lost its first point when that point was a step up beside the body, and the
    // body walked at the second point, into the wall.
    if (walkedOn) pathFromPlayer(results.path)
    walkedOn = false
    const first = results.path[0]
    if (digging) {
      const next = first && first.toBreak[0]
      if (next && diggingAt && next.x === diggingAt.x && next.y === diggingAt.y && next.z === diggingAt.z) {
        first.toBreak.shift()
      } else {
        digDropped = true
        bot.on('diggingAborted', detectDiggingStopped)
        bot.on('diggingCompleted', detectDiggingStopped)
        bot.stopDigging()
      }
    }
    lockEquipItem.release()
    lockPlaceBlock.release()
    lockUseBlock.release()
    path = results.path
  }

  function monitorMovement () {
    // Test freemotion
    if (stateMovements && stateMovements.allowFreeMotion && stateGoal && stateGoal.entity) {
      const target = stateGoal.entity
      if (physics.canStraightLine([target.position])) {
        bot.lookAt(target.position.offset(0, 1.6, 0))

        if (target.position.distanceSquared(bot.entity.position) > stateGoal.rangeSq) {
          bot.setControlState('forward', true)
        } else {
          bot.clearControlStates()
        }
        return
      }
    }
    if (stateGoal) {
      if (!stateGoal.isValid()) {
        stop()
      } else if (stateGoal.hasChanged()) {
        resetPath('goal_moved', false)
      }
    }

    if (astarContext && astartTimedout) {
      const results = astarContext.compute()
      results.path = postProcessPath(results.path)
      pathFromPlayer(results.path)
      const revision = pathRevision
      bot.emit('path_update', results)
      if (revision !== pathRevision) return
      if (found) found = results
      else path = results.path
      astartTimedout = results.status === 'partial'
      if (results.status === 'timeout') pathUpdated = false
    }

    if (bot.pathfinder.LOSWhenPlacingBlocks && returningPos) {
      if (!moveToBlock(returningPos)) return
      returningPos = null
    }

    if (path.length === 0 || searchDue) {
      if (path.length === 0) lastNodeTime = performance.now()
      if (stateGoal && stateMovements) {
        if (path.length === 0 && !found && stateGoal.isEnd(bot.entity.position.floored())) {
          if (!dynamicGoal) {
            bot.emit('goal_reached', stateGoal)
            stateGoal = null
            fullStop()
          }
        } else if (!pathUpdated && !found) {
          // A search starts from the block the body stands in. In the middle of a jump or a fall it
          // stands in none yet (a path dropped at the top of a jump was planned from a block up in the
          // air, and its first step could not be walked): the search waits for the landing, for at
          // most AIR_TICKS ticks. A body that is still read as off the ground then is not in a
          // jump or a short fall (it can be read so where it stands): the search starts anyway.
          if (inTheAir() && airTicks < AIR_TICKS) {
            airTicks++
            if (path.length === 0) return
          } else {
            airTicks = 0
            const results = bot.pathfinder.getPathTo(stateMovements, stateGoal)
            const revision = pathRevision
            bot.emit('path_update', results)
            if (revision !== pathRevision) return
            found = results
            walkedOn = path.length > 0
            useAt = performance.now() + SEARCH_HEAD_MS
            searchDue = false
            astartTimedout = results.status === 'partial'
            // out of time: search again once its partial path is walked
            pathUpdated = results.status !== 'timeout'
          }
        }
      }
    }

    // With no path to go on by, the result is used at once: the body does not stand and wait.
    // (A placement under way is let end first: it lasts a jump at most.)
    if (found && !placing && (found.status !== 'partial' || path.length === 0 || performance.now() >= useAt)) useFound()

    if (path.length === 0) {
      return
    }

    let nextPoint = path[0]
    const p = bot.entity.position

    // Handle digging
    if (digging || nextPoint.toBreak.length > 0) {
      if (!digging && bot.entity.onGround) {
        digging = true
        const b = nextPoint.toBreak.shift()
        const block = bot.blockAt(new Vec3(b.x, b.y, b.z), false)
        diggingAt = b
        const tool = bot.pathfinder.bestHarvestTool(block)
        fullStop()

        const digBlock = () => {
          bot.dig(block, true)
            .catch(_ignoreError => {
              if (digDropped) digDropped = false
              else resetPath('dig_error')
            })
            .then(function () {
              lastNodeTime = performance.now()
              digging = false
            })
        }

        if (!tool) {
          digBlock()
        } else {
          bot.equip(tool, 'hand')
            .catch(_ignoreError => {})
            .then(() => digBlock())
        }
      }
      return
    }
    // Handle block placement
    // TODO: sneak when placing or make sure the block is not interactive
    if (placing || nextPoint.toPlace.length > 0) {
      if (!placing) {
        placing = true
        placingBlock = nextPoint.toPlace.shift()
        fullStop()
      }

      // Open gates or doors
      if (placingBlock?.useOne) {
        if (!lockUseBlock.tryAcquire()) return
        bot.activateBlock(bot.blockAt(new Vec3(placingBlock.x, placingBlock.y, placingBlock.z))).then(() => {
          lockUseBlock.release()
          placingBlock = nextPoint.toPlace.shift()
        }, err => {
          console.error(err)
          lockUseBlock.release()
        })
        return
      }
      const block = stateMovements.getScaffoldingItem()
      if (!block) {
        resetPath('no_scaffolding_blocks')
        return
      }
      if (bot.pathfinder.LOSWhenPlacingBlocks && placingBlock.y === bot.entity.position.floored().y - 1 && placingBlock.dy === 0) {
        if (!moveToEdge(new Vec3(placingBlock.x, placingBlock.y, placingBlock.z), new Vec3(placingBlock.dx, 0, placingBlock.dz))) return
      }
      let canPlace = true
      if (placingBlock.jump) {
        bot.setControlState('jump', true)
        // The block goes under the body once the feet are above where its top will be
        // (PrismarineJS/mineflayer-pathfinder#296): placed earlier, it is inside the body and
        // the game refuses it.
        canPlace = placingBlock.y + 2.1 < bot.entity.position.y
      }
      if (canPlace) {
        if (!lockEquipItem.tryAcquire()) return
        bot.equip(block, 'hand')
          .then(function () {
            lockEquipItem.release()
            const refBlock = bot.blockAt(new Vec3(placingBlock.x, placingBlock.y, placingBlock.z), false)
            if (!lockPlaceBlock.tryAcquire()) return
            if (interactableBlocks.includes(refBlock.name)) {
              bot.setControlState('sneak', true)
            }
            // (the head turns at once: a turn over several ticks sends the block after the body has moved on)
            const placement = bot._placeBlockWithOptions(refBlock, new Vec3(placingBlock.dx, placingBlock.dy, placingBlock.dz), { swingArm: 'right', forceLook: true })
            // A block placed under a jump is there within that jump or not at all. The bot waits
            // 5 seconds for the server's answer to a placement; with jump held and the placing lock
            // taken, one placement the server did not answer kept the body jumping in place for all
            // of them. A jump placement is given up after JUMP_PLACE_MS and tried again.
            let waited = null
            const settled = !placingBlock.jump
              ? placement
              : Promise.race([placement, new Promise((resolve, reject) => {
                waited = setTimeout(() => reject(new Error('no answer to the placement within one jump')), JUMP_PLACE_MS)
              })])
            placement.catch(() => {})
            settled
              .then(function () {
                // Dont release Sneak if the block placement was not successful
                bot.setControlState('sneak', false)
                if (bot.pathfinder.LOSWhenPlacingBlocks && placingBlock.returnPos) returningPos = placingBlock.returnPos.clone()
              })
              .catch(_ignoreError => {
                resetPath('place_error')
              })
              .then(() => {
                if (waited) clearTimeout(waited)
                lockPlaceBlock.release()
                placing = false
                lastNodeTime = performance.now()
              })
          })
          .catch(_ignoreError => {
            // The item could not be taken in hand (the game refuses a click now and then): without
            // this the lock stayed taken, and the body jumped in place for as long as the goal stood.
            lockEquipItem.release()
            resetPath('place_error')
          })
      }
      return
    }

    let dx = nextPoint.x - p.x
    const dy = nextPoint.y - p.y
    let dz = nextPoint.z - p.z
    if ((Math.abs(dx) <= 0.35 && Math.abs(dz) <= 0.35 && Math.abs(dy) < (bot.entity.isInWater && dy > 0 ? 0.25 : 1)) ||
        passedInWater(p)) {
      // arrived at next point
      lastNodeTime = performance.now()
      if (stopPathing) {
        stop()
        return
      }
      path.shift()
      if (path.length === 0) { // done
        // If the block the bot is standing on is not a full block only checking for the floored position can fail as
        // the distance to the goal can get greater then 0 when the vector is floored.
        if (!dynamicGoal && stateGoal && (stateGoal.isEnd(p.floored()) || stateGoal.isEnd(p.floored().offset(0, 1, 0)))) {
          bot.emit('goal_reached', stateGoal)
          stateGoal = null
        }
        fullStop()
        return
      }
      // not done yet
      nextPoint = path[0]
      if (nextPoint.toBreak.length > 0 || nextPoint.toPlace.length > 0) {
        fullStop()
        return
      }
      dx = nextPoint.x - p.x
      dz = nextPoint.z - p.z
    }

    bot.look(Math.atan2(-dx, -dz), 0)
    bot.setControlState('forward', true)
    bot.setControlState('jump', false)

    if (bot.entity.isInWater) {
      if (Math.abs(dx) <= 0.35 && Math.abs(dz) <= 0.35) bot.setControlState('forward', false)
      bot.setControlState('jump', true)
      bot.setControlState('sprint', false)
    } else if (stateMovements.allowSprinting && physics.canStraightLine(path, true)) {
      bot.setControlState('jump', false)
      bot.setControlState('sprint', true)
    } else if (stateMovements.allowSprinting && physics.canSprintJump(path)) {
      bot.setControlState('jump', true)
      bot.setControlState('sprint', true)
    } else if (physics.canStraightLine(path)) {
      bot.setControlState('jump', false)
      bot.setControlState('sprint', false)
    } else if (physics.canWalkJump(path)) {
      bot.setControlState('jump', true)
      bot.setControlState('sprint', false)
    } else {
      bot.setControlState('forward', false)
      bot.setControlState('sprint', false)
    }

    // check for futility
    if (performance.now() - lastNodeTime > 3500) {
      // should never take this long to go to the next node
      resetPath('stuck')
    }
  }
}

module.exports = {
  pathfinder: inject,
  Movements: require('./lib/movements'),
  goals: require('./lib/goals'),
  createHuman: require('./lib/human').createHuman
}
