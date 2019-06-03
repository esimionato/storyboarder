const THREE = require('three')
window.THREE = window.THREE || THREE
const { Canvas, useThree, useRender } = require('react-three-fiber')

const { connect } = require('react-redux')
const React = require('react')
const { useEffect, useRef, useMemo, useState, useReducer } = React

const {
  createObject,
  updateObject,
  deleteObjects,
  duplicateObjects,
  selectBone,
  updateCharacterSkeleton,

  getSceneObjects,
  getWorld,
  getActiveCamera,
  getSelectedBone
} = require('../../shared/reducers/shot-generator')

// all pose presets (so we can use `stand` for new characters)
const defaultPosePresets = require('../../shared/reducers/shot-generator-presets/poses.json')
// id of the pose preset used for new characters
const DEFAULT_POSE_PRESET_ID = '79BBBD0D-6BA2-4D84-9B71-EE661AB6E5AE'

const { WEBVR } = require('../../vendor/three/examples/js/vr/WebVR')
require('../../vendor/three/examples/js/loaders/LoaderSupport')
require('../../vendor/three/examples/js/loaders/GLTFLoader')
require('../../vendor/three/examples/js/loaders/OBJLoader2')

const SGWorld = require('./components/SGWorld')
const SGSpotLight = require('./components/SGSpotLight')
const SGCamera = require('./components/SGCamera')
const SGVirtualCamera = require('./components/SGVirtualCamera')
const SGModel = require('./components/SGModel')
const SGController = require('./components/SGController')
const SGCharacter = require('./components/SGCharacter')
const GUI = require('./gui/GUI')

const { getIntersections, boneIntersect, intersectObjects } = require('./utils/xrControllerFuncs')
require('./lib/VRController')

const RStats = require('./lib/rStats')
require('./lib/rStats.extras')

const applyDeviceQuaternion = require('../../shot-generator/apply-device-quaternion')

const loadingManager = new THREE.LoadingManager()
const objLoader = new THREE.OBJLoader2(loadingManager)
const gltfLoader = new THREE.GLTFLoader(loadingManager)
objLoader.setLogging(false, false)
THREE.Cache.enabled = true

const controllerObjectSettings = {
  id: 'controller',
  model: 'controller-left',
  displayName: 'Controller',
  depth: 0.025,
  height: 0.025,
  width: 0.025,
  rotation: { x: (Math.PI / 180) * -45, y: 0, z: 0 },
  type: 'object',
  visible: true,
  x: 0,
  y: 0,
  z: 0
}

const getFilepathForLoadable = ({ type, model }) => {
  // does the model name have a slash in it?
  // TODO support windows file delimiter
  let isUserModel = !!model.match(/\//)

  if (isUserModel) {
    const parts = model.split(/\//)
    const filename = parts[parts.length - 1]

    switch (type) {
      case 'character':
        return `/data/user/characters/${filename}`
      case 'object':
        return `/data/user/objects/${filename}`
      case 'environment':
        return `/data/user/environments/${filename}`
      default:
        return null
    }
  } else {
    switch (type) {
      case 'character':
        return `/data/system/dummies/gltf/${model}.glb`
      case 'object':
        return `/data/system/objects/${model}.glb`
      default:
        return null
    }
  }
}

const useAttachmentLoader = ({ sceneObjects, world }) => {
  // TODO why do PENDING and SUCCESS get dispatched twice?
  const [attachments, dispatch] = useReducer((state, action) => {
    switch (action.type) {
      case 'PENDING':
        // ignore if already exists
        return (state[action.payload.id])
          ? state
          : {
              ...state,
              [action.payload.id]: { status: 'NotAsked' }
            }
      case 'LOAD':
        // ignore if already loading
        return (state[action.payload.id].loading)
          ? state
          : {
              ...state,
              [action.payload.id]: { status: 'Loading', progress: undefined }
            }
      case 'PROGRESS':
        return {
          ...state,
          [action.payload.id]: {
            ...[action.payload.id],
            progress: {
              loaded: action.payload.progress.loaded,
              total: action.payload.progress.total,
              percent: Math.floor(action.payload.progress.loaded/action.payload.progress.total) * 100
            }
          }
        }
      case 'SUCCESS':
        return {
          ...state,
          [action.payload.id]: { status: 'Success', value: action.payload.value }
        }
      case 'ERROR':
        return {
          ...state,
          [action.payload.id]: { status: 'Error', error: action.payload.error }
        }
      default:
        return state
    }
  }, {})

  useMemo(() => {
    let loadables = Object.values(sceneObjects)
      // has a value for model
      .filter(o => o.model != null)
      // has not loaded yet
      .filter(o => o.loaded !== true)
      // is not a box
      .filter(o => !(o.type === 'object' && o.model === 'box'))

    world.environment.file && loadables.push(
      { type: 'environment', model: world.environment.file }
    )

    loadables.push(controllerObjectSettings)

    loadables.forEach(o =>
      dispatch({ type: 'PENDING', payload: { id: getFilepathForLoadable({ type: o.type, model: o.model }) } })
    )
  }, [sceneObjects])

  useMemo(() => {
    Object.entries(attachments)
      .filter(([k, v]) => v.status === 'NotAsked')
      .forEach(([k, v]) => {
        gltfLoader.load(
          k,
          value => dispatch({ type: 'SUCCESS', payload: { id: k, value } }),
          progress => dispatch({ type: 'PROGRESS', payload: { id: k, progress } }),
          error => dispatch({ type: 'ERROR', payload: { id: k, error } })
        )
        dispatch({ type: 'LOAD', payload: { id: k } })
      })
  }, [attachments])

  return attachments
}

const SceneContent = ({
  aspectRatio,
  sceneObjects,
  getModelData,
  activeCamera,
  world,
  createObject,
  updateObject,
  deleteObjects,
  duplicateObjects,
  selectedBone,
  selectBone,
  updateCharacterSkeleton
}) => {
  const rStatsRef = useRef(null)
  const xrOffset = useRef(null)

  const [guiMode, setGuiMode] = useState('selection')
  const [addMode, setAddMode] = useState(null)
  const [virtualCamVisible, setVirtualCamVisible] = useState(true)
  const [currentBoard, setCurrentBoard] = useState(null)
  const [camExtraRot, setCamExtraRot] = useState(0)
  const [teleportPos, setTeleportPos] = useState(null)
  const [selectedObject, setSelectedObject] = useState(null)
  const [XRControllers, setXRControllers] = useState({})
  const [guiCamFOV, setGuiCamFOV] = useState(22)
  const [hideArray, setHideArray] = useState([])

  const moveObjRef = useRef(null)
  const rotateObjRef = useRef(null)
  const isPressed = useRef(false)
  const isGripped = useRef(false)

  const moveCamRef = useRef(null)
  const rotateCamRef = useRef(null)
  const XRControllersRef = useRef({})
  const intersectArray = useRef([])
  const guiArray = useRef([])
  const teleportArray = useRef([])
  const teleportMode = useRef(false)
  const initialCamPos = useRef()

  // Why do I need to create ref to access updated state in some functions?
  const guiModeRef = useRef(null)
  const selectedObjRef = useRef(null)

  // Rotate Bone
  let isControllerRotatingCurrent = useRef(false)
  let startingObjectQuaternion = useRef(null)
  let startingDeviceOffset = useRef(null)
  let startingObjectOffset = useRef(null)
  let startingDeviceRotation = useRef(null)

  XRControllersRef.current = XRControllers
  guiModeRef.current = guiMode

  const findParent = obj => {
    while (obj) {
      if (!obj.parent || obj.parent.type === 'Scene') {
        return obj
      }
      obj = obj.parent
    }

    return null
  }

  const { gl, scene, camera, setDefaultCamera } = useThree()

  const onVRControllerConnected = event => {
    let id = THREE.Math.generateUUID()

    let controller = event.detail
    controller.standingMatrix = gl.vr.getStandingMatrix()

    // TODO
    // controller.head = window.camera

    controller.addEventListener('trigger press began', onSelectStart)
    controller.addEventListener('trigger press ended', onSelectEnd)
    controller.addEventListener('grip press began', onGripDown)
    controller.addEventListener('grip press ended', onGripUp)
    controller.addEventListener('thumbstick axes changed', onAxisChanged)
    controller.addEventListener('thumbpad axes changed', onAxisChanged)

    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)])
    const material = new THREE.LineBasicMaterial({
      color: 0x0000ff,
      depthTest: false,
      depthWrite: false,
      transparent: true
    })

    const line = new THREE.Line(geometry, material)
    line.name = 'line'
    line.scale.z = 5
    line.rotation.x = (Math.PI / 180) * -45
    controller.add(line)

    const raycastTiltGroup = new THREE.Group()
    const raycastDepth = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial())
    raycastDepth.visible = false
    raycastDepth.name = 'raycast-depth'
    raycastTiltGroup.rotation.x = (Math.PI / 180) * -45
    raycastTiltGroup.add(raycastDepth)

    controller.add(raycastTiltGroup)

    controller.intersections = []
    controller.pressed = false
    controller.gripped = false
    controller.interaction = {
      grip: undefined,
      press: undefined,
      hover: undefined
    }

    controller.addEventListener('disconnected', function(event) {
      controller.parent.remove(controller)

      // Try if this works as expected?
      const { id, ...controllers } = XRControllers
      setXRControllers(controllers)
    })

    setXRControllers(prev => {
      return { ...prev, [id]: controller }
    })
  }

  const updateGUIProp = e => {
    const { id, prop, value } = e.detail

    if (prop === 'guiFOV') {
      setGuiCamFOV(value)
      return
    }

    switch (prop) {
      case 'size':
        updateObject(id, {
          width: value,
          height: value,
          depth: value
        })
        break
      case 'mesomorphic':
      case 'ectomorphic':
      case 'endomorphic':
        updateObject(id, {
          morphTargets: { [prop]: value }
        })
        break
      default:
        updateObject(id, { [prop]: value })
        break
    }
  }

  useEffect(() => {
    window.addEventListener('updateRedux', updateGUIProp)
    window.addEventListener('vr controller connected', onVRControllerConnected)
    return () => {
      window.removeEventListener('updateRedux', updateGUIProp)
      window.removeEventListener('vr controller connected', onVRControllerConnected)
    }
  }, [])

  useRender(() => {
    if (rStatsRef.current) {
      rStatsRef.current('rAF').tick()
      rStatsRef.current('FPS').frame()
      rStatsRef.current().update()
    }

    THREE.VRController.update()

    Object.values(XRControllersRef.current).forEach(controller => {
      const intersections = getIntersections(controller, guiArray.current)
      if (intersections.length > 0) {
        let intersection = intersections[0]
        if (intersection.object.userData.type === 'slider') {
          controller.intersections = intersections
        }
      }

      const object = controller.userData.selected
      if (object && object.userData.type === 'character') {
        constraintObjectRotation(controller)
      }

      if (controller.userData.bone) rotateBone(controller)
    })
  })

  const createHideArray = () => {
    const array = []
    scene.traverse(child => {
      if (
        child.type === 'Line' ||
        child.userData.type === 'virtual-camera' ||
        child.userData.id === 'controller' ||
        child.userData.type === 'gui' ||
        child.userData.type === 'bone'
      ) {
        array.push(child)
      }
    })
    return array
  }

  const constraintObjectRotation = controller => {
    const object = controller.userData.selected

    const raycastDepth = controller.getObjectByName('raycast-depth')
    const depthWorldPos = raycastDepth.getWorldPosition(new THREE.Vector3())
    depthWorldPos.sub(controller.userData.posOffset)
    object.position.copy(depthWorldPos)

    const quaternion = new THREE.Quaternion()
    controller.matrixWorld.decompose(new THREE.Vector3(), quaternion, new THREE.Vector3())
    const newMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(),
      quaternion,
      new THREE.Vector3(1, 1, 1)
    )

    const rotVector = new THREE.Vector3(1, 0, 0).applyMatrix4(newMatrix)
    const rotTheta = Math.atan2(rotVector.y, rotVector.x)
    object.rotation.y = -rotTheta + object.userData.modelSettings.rotation + controller.userData.rotOffset
  }

  const onTeleport = event => {
    var controller = event.target
    const intersect = intersectObjects(controller, teleportArray.current)

    if (intersect && intersect.distance < 10) {
      // console.log('try to teleport')
      Object.values(XRControllers).forEach(controller => {
        controller.dispatchEvent({ type: 'trigger press ended' })
      })

      setTeleportPos(intersect.point)
    }
  }

  const rotateBone = controller => {
    const target = controller.userData.bone

    if (!isControllerRotatingCurrent.current) {
      isControllerRotatingCurrent.current = true
      let startValues = new THREE.Matrix4().extractRotation(controller.matrixWorld)
      startingDeviceRotation.current = new THREE.Quaternion().setFromRotationMatrix(startValues)

      startingDeviceOffset.current = new THREE.Quaternion()
        .clone()
        .inverse()
        .multiply(startingDeviceRotation.current)
        .normalize()
        .inverse()
      startingObjectQuaternion.current = target.quaternion.clone()
      startingObjectOffset.current = new THREE.Quaternion()
        .clone()
        .inverse()
        .multiply(startingObjectQuaternion.current)
    }

    let middleValues = new THREE.Matrix4().extractRotation(controller.matrixWorld)
    let deviceQuaternion = new THREE.Quaternion().setFromRotationMatrix(middleValues)

    let objectQuaternion = applyDeviceQuaternion({
      parent: target.parent,
      startingDeviceOffset: startingDeviceOffset.current,
      startingObjectOffset: startingObjectOffset.current,
      startingObjectQuaternion: startingObjectQuaternion.current,
      deviceQuaternion,
      camera
    })

    target.quaternion.copy(objectQuaternion.normalize())
  }

  const onSelectStart = event => {
    const controller = event.target
    const otherController = Object.values(XRControllersRef.current).find(i => i.uuid !== controller.uuid)
    if (otherController && otherController.userData.selected) return

    if (teleportMode.current) {
      onTeleport(event)
      return
    }

    if (selectedObjRef.current && selectedObjRef.current.userData.type === 'character') {
      const bonesHelper = selectedObjRef.current.children[0].bonesHelper
      const hits = boneIntersect(controller, bonesHelper)
      if (hits.length) {
        controller.userData.bone = hits[0].bone
        selectBone(hits[0].bone.uuid)
        return
      }
    }

    const intersections = getIntersections(controller, intersectArray.current)

    if (intersections.length > 0) {
      let intersection = intersections[0]

      if (intersection.object.userData.type === 'slider') {
        controller.pressed = true
        controller.intersections = intersections
        return
      }

      if (intersection.object.userData.type === 'view') {
        intersection = intersections[1]
      }

      if (intersection.object.userData.type === 'gui') {
        const { name } = intersection.object
        if (name.includes('mode')) {
          const mode = name.split('_')[0]

          switch (mode) {
            case 'add':
              setGuiMode(mode)
              setSelectedObject(0)
              selectedObjRef.current = null
              setHideArray(createHideArray())
              break
            case 'selection':
              setGuiMode(mode)
              break
            case 'erase':
              if (!selectedObjRef.current) return
              if (selectedObjRef.current.userData.id === activeCamera) return
              setGuiMode(mode)

              deleteObjects([selectedObjRef.current.userData.id])
              setSelectedObject(0)
              selectedObjRef.current = null
              setHideArray(createHideArray())

              setTimeout(() => {
                setGuiMode('selection')
              }, 250)
              break
            case 'duplicate':
              if (!selectedObjRef.current) return
              setGuiMode(mode)

              const id = THREE.Math.generateUUID()
              duplicateObjects([selectedObjRef.current.userData.id], [id])

              setTimeout(() => {
                const match = scene.children.find(child => child.userData.id === id)
                setSelectedObject(match.id)
                selectedObjRef.current = match
                setHideArray(createHideArray())
                setGuiMode('selection')
              }, 250)
              break
          }
        }

        if (name.includes('_add')) {
          const mode = name.split('_')[0]
          const id = THREE.Math.generateUUID()
          const newPoz = new THREE.Vector3()

          switch (mode) {
            case 'camera':
              setAddMode('camera')

              createObject({
                id,

                type: 'camera',
                fov: 22.25,
                x: 0,
                y: 6,
                z: 2,
                rotation: 0,
                tilt: 0,
                roll: 0
              })
              break
            case 'object':
              setAddMode('object')

              createObject({
                id,
                type: 'object',
                model: 'box',
                width: 1,
                height: 1,
                depth: 1,
                x: newPoz.x,
                y: newPoz.y,
                z: newPoz.z,
                rotation: { x: 0, y: 0, z: 0 }, //Math.random() * Math.PI * 2,

                visible: true
              })
              break
            case 'character':
              setAddMode('character')

              createObject({
                id,
                type: 'character',
                height: 1.8,
                model: 'adult-male',
                x: newPoz.x,
                y: newPoz.y,
                z: newPoz.z,
                rotation: 0, //newPoz.rotation,
                headScale: 1,

                morphTargets: {
                  mesomorphic: 0,
                  ectomorphic: 0,
                  endomorphic: 0
                },

                posePresetId: DEFAULT_POSE_PRESET_ID,
                skeleton: defaultPosePresets[DEFAULT_POSE_PRESET_ID].state.skeleton,

                visible: true
              })
              break
            case 'light':
              setAddMode('light')

              createObject({
                id,
                type: 'light',
                x: 0,
                y: 0,
                z: 2,
                rotation: 0,
                tilt: 0,
                intensity: 0.8,
                visible: true,
                angle: 1.04,
                distance: 5,
                penumbra: 1.0,
                decay: 1
              })
              break
          }

          setTimeout(() => {
            setAddMode(null)
            setGuiMode('selection')
          }, 250)
        }

        if (name.includes('board')) {
          const board = name.split('_')[0]
          setCurrentBoard(board)
          setTimeout(() => {
            setCurrentBoard(null)
          }, 250)
        }

        if (name.includes('button')) {
          const button = name.split('_')[0]
          if (button === 'eye')
            setVirtualCamVisible(oldValue => {
              return !oldValue
            })
        }

        return
      }

      if (guiModeRef.current !== 'selection') return

      if (intersection.object.userData.type === 'hitter' && intersection.object.parent.userData.character) {
        if (!intersection.object.parent.userData.character) return
        intersection.object = intersection.object.parent.userData.character
      }

      let object = findParent(intersection.object)
      const { id } = object
      setSelectedObject(id)
      selectedObjRef.current = scene.getObjectById(id)
      setHideArray(createHideArray())

      if (object.userData.type === 'character') {
        if (object.userData.name === 'character-container') object = object.children[0]

        const raycastDepth = controller.getObjectByName('raycast-depth')
        raycastDepth.position.z = -intersection.distance

        const objectWorldPos = intersection.object.getWorldPosition(new THREE.Vector3())
        const posOffset = new THREE.Vector3().subVectors(intersection.point, objectWorldPos)
        controller.userData.posOffset = posOffset

        const quaternion = new THREE.Quaternion()
        controller.matrixWorld.decompose(new THREE.Vector3(), quaternion, new THREE.Vector3())
        const newMatrix = new THREE.Matrix4().compose(
          new THREE.Vector3(),
          quaternion,
          new THREE.Vector3(1, 1, 1)
        )

        const rotVector = new THREE.Vector3(1, 0, 0).applyMatrix4(newMatrix)
        const rotOffset = Math.atan2(rotVector.y, rotVector.x)
        controller.userData.rotOffset = rotOffset
      } else {
        const tempMatrix = new THREE.Matrix4()
        tempMatrix.getInverse(controller.matrixWorld)

        object.matrix.premultiply(tempMatrix)
        object.matrix.decompose(object.position, object.quaternion, object.scale)
        controller.add(object)
      }

      controller.userData.selected = object

      const objMaterial = intersection.object.material
      if (Array.isArray(objMaterial)) {
        objMaterial.forEach(material => {
          if (!material.emissive) return
          material.emissive.b = 0.15
        })
      } else {
        if (!objMaterial.emissive) return
        objMaterial.emissive.b = 0.15
      }
    }
  }

  const onSelectEnd = event => {
    const controller = event.target
    controller.pressed = false

    if (controller.userData.bone) {
      const target = controller.userData.bone
      const parent = findParent(target)
      let rotation = new THREE.Euler()
      rotation.setFromQuaternion(target.quaternion.clone().normalize(), 'XYZ')

      updateCharacterSkeleton({
        id: parent.userData.id,
        name: target.name,
        rotation: {
          x: rotation.x,
          y: rotation.y,
          z: rotation.z
        }
      })

      controller.userData.bone = undefined
      isControllerRotatingCurrent.current = false
    }

    if (controller.userData.selected !== undefined) {
      const object = controller.userData.selected

      if (object.userData.type !== 'character') {
        object.matrix.premultiply(controller.matrixWorld)
        object.matrix.decompose(object.position, object.quaternion, object.scale)
        scene.add(object)
      }

      controller.userData.selected = undefined

      object.traverse(child => {
        if (child instanceof THREE.Mesh) {
          const objMaterial = child.material
          if (Array.isArray(objMaterial)) {
            objMaterial.forEach(material => {
              if (!material.emissive) return
              material.emissive.b = 0
            })
          } else {
            if (!objMaterial.emissive) return
            objMaterial.emissive.b = 0
          }
        }
      })

      useUpdateObject(object)
    }

    selectBone(null)
  }

  const useUpdateObject = object => {
    if (object.userData.type === 'character' || object.userData.type === 'light') {
      updateObject(object.userData.id, {
        x: object.position.x,
        y: object.position.z,
        z: object.position.y,
        rotation: object.rotation.y
      })
    } else if (object.userData.type === 'virtual-camera') {
      updateObject(object.userData.id, {
        x: object.position.x,
        y: object.position.z,
        z: object.position.y
      })
    } else {
      updateObject(object.userData.id, {
        x: object.position.x,
        y: object.position.z,
        z: object.position.y,
        rotation: { x: object.rotation.x, y: object.rotation.y, z: object.rotation.z }
      })
    }
  }

  const onAxisChanged = event => {
    let selected = false
    Object.values(XRControllersRef.current).forEach(controller => {
      if (!selected) selected = controller.userData.selected ? controller : false
    })

    if (selected) {
      moveObject(event, selected)
      rotateObject(event, selected)
    } else {
      moveCamera(event)
      rotateCamera(event)
    }
  }

  const moveObject = (event, controller) => {
    if (event.axes[1] === 0) {
      moveObjRef.current = null
    }

    if (moveObjRef.current) return
    if (Math.abs(event.axes[1]) < Math.abs(event.axes[0])) return

    if (event.axes[1] > 0.075) {
      moveObjRef.current = 'Backwards'

      const object = controller.userData.selected
      if (object.userData.type === 'character') {
        const raycastDepth = controller.getObjectByName('raycast-depth')
        raycastDepth.position.add(new THREE.Vector3(0, 0, 1))
      } else {
        // 45 degree tilt down on controller
        let offsetVector = new THREE.Vector3(0, 1, 1)
        object.position.add(offsetVector)
      }
    }

    if (event.axes[1] < -0.075) {
      moveObjRef.current = 'Forwards'

      const object = controller.userData.selected
      if (object.userData.type === 'character') {
        const raycastDepth = controller.getObjectByName('raycast-depth')
        raycastDepth.position.add(new THREE.Vector3(0, 0, -1))
      } else {
        // 45 degree tilt down on controller
        let offsetVector = new THREE.Vector3(0, -1, -1)
        object.position.add(offsetVector)
      }
    }
  }

  const rotateObject = (event, controller) => {
    const object = controller.userData.selected

    if (event.axes[0] === 0) {
      rotateObjRef.current = null
    }

    if (rotateObjRef.current) return
    if (Math.abs(event.axes[0]) < Math.abs(event.axes[1])) return

    if (event.axes[0] > 0.075) {
      rotateObjRef.current = 'Right'

      const object = controller.userData.selected
      if (object.userData.type === 'character') {
        object.userData.modelSettings.rotation += Math.PI / 4
      } else {
        object.rotateY(Math.PI / 4)
      }
    }

    if (event.axes[0] < -0.075) {
      rotateObjRef.current = 'Left'
      const object = controller.userData.selected
      if (object.userData.type === 'character') {
        object.userData.modelSettings.rotation -= Math.PI / 4
      } else {
        object.rotateY(-Math.PI / 4)
      }
    }
  }

  const moveCamera = event => {
    if (event.axes[1] === 0) {
      moveCamRef.current = null
    }

    if (moveCamRef.current) return
    if (Math.abs(event.axes[1]) < Math.abs(event.axes[0])) return

    const { x, y } = xrOffset.current.userData
    const hmdCam = xrOffset.current.children.filter(child => child.type === 'PerspectiveCamera')[0]

    if (event.axes[1] > 0.075) {
      Object.values(XRControllersRef.current).forEach(controller => {
        controller.dispatchEvent({ type: 'trigger press ended' })
      })

      moveCamRef.current = 'Backwards'

      let offsetVector = new THREE.Vector3(0, 0, 1)
      offsetVector.applyMatrix4(new THREE.Matrix4().extractRotation(hmdCam.matrixWorld))
      offsetVector = offsetVector.multiply(new THREE.Vector3(1, 0, 1)).normalize()

      setTeleportPos(oldPos => {
        if (!oldPos) {
          offsetVector.add(new THREE.Vector3(x, 0, y))
          return offsetVector
        } else {
          return oldPos.clone().add(offsetVector)
        }
      })
    }

    if (event.axes[1] < -0.075) {
      Object.values(XRControllersRef.current).forEach(controller => {
        controller.dispatchEvent({ type: 'trigger press ended' })
      })

      moveCamRef.current = 'Forwards'

      let offsetVector = new THREE.Vector3(0, 0, -1)
      offsetVector.applyMatrix4(new THREE.Matrix4().extractRotation(hmdCam.matrixWorld))
      offsetVector = offsetVector.multiply(new THREE.Vector3(1, 0, 1)).normalize()

      setTeleportPos(oldPos => {
        if (!oldPos) {
          offsetVector.add(new THREE.Vector3(x, 0, y))
          return offsetVector
        } else {
          return oldPos.clone().add(offsetVector)
        }
      })
    }
  }

  const rotateCamera = event => {
    if (event.axes[0] === 0) {
      rotateCamRef.current = null
    }

    if (rotateCamRef.current) return
    if (Math.abs(event.axes[0]) < Math.abs(event.axes[1])) return

    if (event.axes[0] > 0.075) {
      Object.values(XRControllersRef.current).forEach(controller => {
        controller.dispatchEvent({ type: 'trigger press ended' })
      })

      rotateCamRef.current = 'Right'
      setCamExtraRot(oldRot => {
        return oldRot - 1
      })
    }

    if (event.axes[0] < -0.075) {
      Object.values(XRControllersRef.current).forEach(controller => {
        controller.dispatchEvent({ type: 'trigger press ended' })
      })

      rotateCamRef.current = 'Left'
      setCamExtraRot(oldRot => {
        return oldRot + 1
      })
    }
  }

  useEffect(() => {
    intersectArray.current = scene.children.filter(
      child =>
        (child instanceof THREE.Mesh || child instanceof THREE.Group) &&
        (child.userData.type !== 'ground' && child.userData.type !== 'room' && child.userData.type !== 'camera')
    )

    guiArray.current = []
    Object.values(XRControllers).forEach(controller => {
      const gui = controller.children.filter(child => child.userData.type === 'gui')[0]

      if (gui) {
        gui.traverse(child => {
          if (child.name === 'properties_container' || child.name === 'fov_slider') {
            intersectArray.current.push(gui)
            guiArray.current.push(gui)
          }
        })
      }
    })

    teleportArray.current = scene.children.filter(child => child.userData.type === 'ground')
  }, [XRControllers, sceneObjects])

  const onGripDown = event => {
    teleportMode.current = true

    const controller = event.target
    const intersections = getIntersections(controller, intersectArray.current)

    if (intersections.length > 0) {
      let intersection = intersections[0]
      if (intersection.object.userData.type === 'slider') {
        controller.gripped = true
        return
      }

      if (intersection.object.userData.type === 'gui') return

      let object = findParent(intersection.object)
      const { id } = object
      setSelectedObject(id)
      selectedObjRef.current = scene.getObjectById(id)
      setHideArray(createHideArray())
    }
  }

  const onGripUp = event => {
    teleportMode.current = false

    const controller = event.target
    controller.gripped = false
  }

  useEffect(() => {
    navigator
      .getVRDisplays()
      .then(displays => {
        // console.log({ displays })
        if (displays.length) {
          console.log('adding VR button')
          scene.background = new THREE.Color(world.backgroundColor)
          document.body.appendChild(WEBVR.createButton(gl))
        }
      })
      .catch(err => console.error(err))

    const threeStats = new window.threeStats(gl)
    rStatsRef.current = new RStats({
      css: [],
      values: {
        fps: { caption: 'fps', below: 30 }
      },
      groups: [{ caption: 'Framerate', values: ['fps', 'raf'] }],
      plugins: [threeStats]
    })
  }, [])

  // if our camera is setup
  // if (activeCamera === camera.userData.id) {
  //   console.log('camera: using user-defined camera')
  // } else {
  //   console.log('camera: using Canvas camera')
  // }

  const camPosZero = camera.position.length() === 0
  if (xrOffset.current && teleportPos) {
    xrOffset.current.position.x = teleportPos.x
    xrOffset.current.position.z = teleportPos.z
  } else if (xrOffset.current && !camPosZero && camera.position.y !== xrOffset.current.userData.z) {
    const { x, y, rotation } = xrOffset.current.userData
    const behindCam = {
      x: Math.sin(rotation),
      y: Math.cos(rotation)
    }

    xrOffset.current.position.x = x + behindCam.x
    xrOffset.current.position.z = y + behindCam.y
  }

  let cameraState = sceneObjects[activeCamera]
  useEffect(() => {
    // Store Initial Camera Position here so HMD doesn't jump even if virtual camera get's updated
    const { x, y, z } = cameraState
    initialCamPos.current = new THREE.Vector3(x, y, z)
  }, [])

  let activeCameraComponent = (
    <group
      key={'camera'}
      ref={xrOffset}
      rotation={[0, (Math.PI / 4) * camExtraRot, 0]}
      userData={{
        x: initialCamPos.current ? initialCamPos.current.x : cameraState.x,
        y: initialCamPos.current ? initialCamPos.current.y : cameraState.y,
        z: initialCamPos.current ? initialCamPos.current.z : cameraState.z,
        rotation: cameraState.rotation,
        type: cameraState.type
      }}
    >
      <SGCamera {...{ aspectRatio, activeCamera, setDefaultCamera, ...cameraState }} />

      {Object.values(XRControllers).map((object, n) => {
        const handedness = object.getHandedness()
        const flipModel = handedness === 'right'

        return (
          <primitive key={n} object={object}>
            {handedness === 'right' && (
              <GUI {...{ aspectRatio, guiMode, addMode, currentBoard, selectedObject, hideArray, virtualCamVisible, guiCamFOV, XRControllers }} />
            )}
            <SGController
              {...{ flipModel, modelData: getModelData(controllerObjectSettings), ...controllerObjectSettings }}
            />
          </primitive>
        )
      })}
    </group>
  )

  let sceneObjectComponents = Object.values(sceneObjects)
    .map((sceneObject, i) => {
      switch (sceneObject.type) {
        case 'camera':
          return virtualCamVisible ? (
            <SGVirtualCamera key={i} {...{ aspectRatio, selectedObject, hideArray, ...sceneObject }} />
          ) : (
            undefined
          )
        case 'character':
          const selectedObj = scene.getObjectById(selectedObject)
          const isSelected = selectedObj && selectedObj.userData.id === sceneObject.id ? true : false
          return (
            <SGCharacter
              key={i}
              {...{ modelData: getModelData(sceneObject), isSelected, updateObject, selectedBone, ...sceneObject }}
            />
          )
        case 'object':
          return <SGModel key={i} {...{ modelData: getModelData(sceneObject), ...sceneObject }} />
        case 'light':
          return <SGSpotLight key={i} {...{ ...sceneObject }} />
      }
    })
    .filter(Boolean)

  const groundTexture = useMemo(() => new THREE.TextureLoader().load('/data/system/grid_floor.png'), [])
  const wallTexture = useMemo(
    () =>
      new THREE.TextureLoader().load('/data/system/grid_wall2.png', texture => {
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping
        texture.offset.set(0, 0)
        texture.repeat.set(4.5, 4.5)
      }),
    []
  )
  const worldComponent = (
    <SGWorld
      {...{
        key: world,
        groundTexture,
        wallTexture,
        world,
        modelData:
          world.environment.file &&
          getModelData({
            model: world.environment.file,
            type: 'environment'
          })
      }}
    />
  )

  // wait until the camera is setup before showing the scene
  const ready = !!xrOffset.current

  // console.log('scene is', ready ? 'shown' : 'not shown')

  return (
    <>
      {activeCameraComponent}
      {sceneObjectComponents.concat(worldComponent)}
    </>
  )
}

const SceneManagerXR = connect(
  state => ({
    aspectRatio: state.aspectRatio,

    world: getWorld(state),
    sceneObjects: getSceneObjects(state),
    selectedBone: getSelectedBone(state),
    activeCamera: getActiveCamera(state)
  }),
  {
    createObject,
    updateObject,
    deleteObjects,
    duplicateObjects,
    selectBone,
    updateCharacterSkeleton
  }
)(
  ({
    aspectRatio,
    world,
    sceneObjects,
    activeCamera,
    createObject,
    updateObject,
    deleteObjects,
    duplicateObjects,
    selectedBone,
    selectBone,
    updateCharacterSkeleton
  }) => {
    const attachments = useAttachmentLoader({ sceneObjects, world })

    const getModelData = sceneObject => {
      let key = getFilepathForLoadable(sceneObject)
      return attachments[key] && attachments[key].value
    }

    return (
      <Canvas vr>
        <SceneContent
          {...{
            aspectRatio,
            sceneObjects,
            getModelData,
            activeCamera,
            world,
            createObject,
            updateObject,
            deleteObjects,
            duplicateObjects,
            selectedBone,
            selectBone,
            updateCharacterSkeleton
          }}
        />
      </Canvas>
    )
 })

module.exports = SceneManagerXR