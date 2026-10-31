// three.js and the loaders used by the details pane preview and Dogfile 3D.
// Rebuild: npx esbuild build/vendor-src/three3d.js --bundle --format=esm --minify --legal-comments=eof --outfile=src/renderer/vendor/three3d.js
export * from 'three';
export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
export { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
export { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
export { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
export { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
export { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
export { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
export { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
export { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
export { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
export { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
export { USDZLoader } from 'three/examples/jsm/loaders/USDZLoader.js';
export { VRMLLoader } from 'three/examples/jsm/loaders/VRMLLoader.js';
export { AMFLoader } from 'three/examples/jsm/loaders/AMFLoader.js';
export { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
export { DDSLoader } from 'three/examples/jsm/loaders/DDSLoader.js';
export { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
export { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
export { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
export { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
export { mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
export { default as DxfParser } from 'dxf-parser';
