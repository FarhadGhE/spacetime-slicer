# Spacetime Slicer

**Try it:** https://fargh.com/spacetime-slicer/

Turn a video (up to 60 s) into a cube of points, with x = column, y = row and z = time (one layer per sampled frame). Then cut through it with a sheet and see what the sheet touches.

- **XY, XZ, ZY** are presets that set the sheet's rotation:
  - **XY** is square to time, so it shows a single frame. Pushing it through the cube plays the video.
  - **XZ** shows one row of pixels over time. Moving things smear into streaks and curves.
  - **ZY** shows one column of pixels over time, like a slit-scan or photo-finish camera.
- **ω, φ, κ** (omega, phi, kappa) tilt the sheet about the x, y and z axes, applied in that order. These are the usual photogrammetry names for rotations about the three axes. Each has a slider and a box for typing exact degrees.
- **Sphere** bends the sheet. At 0 it is flat. At 1 it wraps into a closed sphere around a point behind it.
- **Depth** pushes the sheet through the cube along its normal.

The left panel shows the cube in 3D with the sheet and its handle. The right panel shows the points the sheet touches, laid out flat.

## Run it

It's a static page with no build step and no dependencies. Serve the folder and open it:

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765.

## Controls

- **Open video** or drop a file anywhere. Videos longer than a minute use their first 60 s. iPhone clips (HEVC `.mov`) are supported.
- **3D view:** drag to orbit, scroll to zoom, drag the sheet's handle along its path, double-click to reset.
- **Flat view:** drag sideways or scroll to push the sheet through the cube.
- **Rotating or bending** the sheet pivots it about its centre (the handle), so it stays where you put it.
- **Keys:** Space plays or pauses, ←/→ step the depth (Shift for 10), and 1/2/3 pick XY/XZ/ZY.
- **Ghost / Cut:** Ghost (the default) shows the whole cube as a faint haze around the sheet. Cut removes the part of the cube between you and the sheet.
- **Detail:** trades sampling resolution (frame size × frame count) and point count for speed. Phones start on Fast.

## How it works

The video's frames are stacked into a WebGL2 3D texture. Both views draw points straight from that texture, using `gl_VertexID` to address voxels or sheet positions, so no per-point buffers are built.

The sheet is parameterised by arc length from its centre. When it is bent, each point is wrapped onto a sphere at that distance, so the flat view is the sphere's surface unrolled around its centre.

Chrome and Firefox sample frames by seeking. Safari and every iOS browser won't seek a video that hasn't started playing, so there the clip plays muted at up to 4× and frames are caught with `requestVideoFrameCallback`.
