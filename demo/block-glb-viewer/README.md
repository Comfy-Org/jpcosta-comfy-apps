# Block-scene GLB viewer

Isolated test page. Not part of the Reverse 3D app.

`avengers-block-detail.html` is one file: the original whole-scene GLB, the 2D reference, and the renderer. Open it directly. The right end of the slider is the untouched 10004-triangle mesh. Moving left welds nearby vertices inside each piece. Pieces are not joined, and columns are not filled.

```bash
python3 -m http.server 3461
```

There is no generated Hunyuan file in this folder yet. An empty page is the waiting state, not a scene.
