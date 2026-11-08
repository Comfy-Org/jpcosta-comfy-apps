# Depth-block preview

Isolated test. Not wired into Reverse 3D and not a production route.

Open `index.html` from this folder over a local static server. The page loads the 512×288 Avengers frame and its matching depth image. White in the depth image is nearer. Blocks are gray on purpose.

```bash
python3 -m http.server 3460
```

Then open `http://127.0.0.1:3460/`.

The main pair is frame 90 at 3.750s. The menu also has 1.250s and 4.750s. The 40° vertical field is an assumption, not a measured lens. Drag is clamped so the unseen back stays out of frame.
