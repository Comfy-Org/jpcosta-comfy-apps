# Block-scene GLB viewer

Isolated test page. Not part of the Reverse 3D app.

Open this folder with a static server and choose a `.glb` file. The page uses three.js `GLTFLoader` and replaces materials with gray. Geometry is the file's own triangles.

```bash
python3 -m http.server 3461
```

There is no generated Hunyuan file in this folder yet. An empty page is the waiting state, not a scene.
