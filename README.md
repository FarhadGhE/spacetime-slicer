# Spacetime Slicer

**Try it:** https://fargh.com/spacetime-slicer/

Turn a video (up to 60 s) into a cube of points, with x = column, y = row and z = time (one layer per sampled frame). Then slide planes through the cube:

- **XY** is a single frame. Sliding it through z plays the video.
- **XZ** is one row of pixels stacked over time. Moving things smear into streaks and curves.
- **ZY** is one column of pixels unrolled across time, like a slit-scan or photo-finish camera.

The left panel shows the cube in 3D with a draggable handle per plane. The right panel shows the points on the active plane.

## Run it

It's a static page with no build step and no dependencies. Serve the folder and open it:

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765.

## Controls

- **Open video** or drop a file anywhere. Videos longer than a minute use their first 60 s.
- **3D view:** drag to orbit, scroll to zoom, drag a coloured handle to slide its plane, double-click to reset.
- **Slice view:** click or drag to move the crosshair (the other two planes), scroll to slide the active plane.
- **Keys:** Space plays or pauses, ←/→ step (Shift for 10), and 1/2/3 pick XY/XZ/ZY.
- **Cut / Ghost:** Cut removes the part of the cube between you and the plane. Ghost shows the whole cube faintly with all three planes.
- **Detail:** trades sampling resolution (frame size × frame count) and point count for speed.

## How it works

Frames are sampled by seeking a hidden `<video>` element and reading each frame through a small canvas. The frames are stacked into a WebGL2 3D texture. Both views draw points straight from that texture, using `gl_VertexID` to address voxels, so no per-point buffers are built.
