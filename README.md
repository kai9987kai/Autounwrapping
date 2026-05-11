# Advanced 3D UV Toolkit — Research Upgrade

A browser-based 3D UV unwrapping and atlas inspection tool built with **Three.js**.  
This project lets users load OBJ models, generate UV coordinates, inspect seams, preview texture stretching, measure distortion, and export an unwrapped OBJ directly from the browser.

The toolkit is designed as an experimental, visual UV laboratory for testing projection methods, chart-aware atlas workflows, seam placement ideas, and UV-quality metrics without needing a desktop DCC package.

---

## ✨ Features

### 3D Model Loading

- Load `.obj` files directly in the browser
- Drag-and-drop OBJ support
- Built-in default sphere model for testing
- Automatic camera fitting after model load
- Orbit camera controls
- Grid toggle
- Wireframe toggle
- Turntable preview mode
- Screenshot capture

---

## UV Unwrapping Modes

The toolkit includes several UV generation strategies:

### Advanced Atlas — Part / Chart Aware

The default experimental mode.

It approximates modern UV atlas workflows by:

- Splitting geometry into multiple charts
- Grouping faces by dominant surface direction
- Optionally increasing chart splits around high-curvature areas
- Packing charts into a padded UV atlas
- Applying a correction exponent to reduce distortion
- Running optional UV relaxation
- Scoring the result with distortion and seam metrics

This is inspired by workflows used in modern atlas generators such as xatlas-style chart creation and packing, but implemented as a lightweight browser-friendly approximation.

### Box / Triplanar Charts

Best for hard-surface or mechanical objects.

- Projects faces based on dominant normal direction
- Creates atlas charts for major surface directions
- Useful for objects with boxy or architectural shapes

### Spherical Projection

Best for round or organic objects.

- Converts vertex positions into spherical coordinates
- Useful for spheres, heads, planets, blobs, and rounded forms

### Cylindrical Projection

Best for tube-like or bottle-like shapes.

- Wraps UVs around the vertical axis
- Uses height as the V coordinate

### Planar Projection

Best for mostly flat surfaces.

- Projects geometry onto the most suitable major plane
- Useful for simple flat meshes, panels, signs, and terrain-like assets

---

## UV Visualization Tools

### Live UV Atlas Preview

A dedicated UV canvas shows:

- Generated UV islands
- Chart boundaries
- Triangle layout
- Atlas packing
- Heatmap overlays
- UV grid reference

### Checker Texture Preview

Applies a procedural checker texture to the 3D model so stretching is easy to see.

Good UVs should keep checker squares mostly square and evenly sized.

### Distortion Heatmap

Optional heatmap mode colors the mesh based on UV distortion.

- Blue / green: lower distortion
- Yellow / red: higher distortion
- Red areas may indicate stretched, compressed, or flipped UVs

### 3D Seam Overlay

Displays detected UV seams directly on the 3D model.

- Yellow line segments mark seams
- Useful for inspecting where the atlas has been cut
- Helps identify visible or excessive seam placement

---

## UV Metrics Dashboard

The toolkit calculates and displays approximate UV quality metrics:

| Metric | Description |
|---|---|
| Charts | Number of UV charts / islands |
| Faces | Total triangle count |
| Seam Length | Approximate total 3D seam length |
| UV Use | Approximate UV atlas area usage |
| Angle Error | Average angular distortion between 3D and UV triangles |
| Flipped | Number of flipped UV triangles |
| Distortion Metric | Combined score based on area variance, angle error, and flipped triangles |

These metrics are intended for comparison and experimentation, not as a perfect replacement for professional offline parameterization solvers.

---

## Optimization Tools

### Optimize UV Unwrap

The optimization pass searches multiple settings and selects a better result based on:

- Distortion score
- Seam length
- Flipped triangle count
- Correction exponent
- Chart split detail

### Relax UV

Applies iterative smoothing to UV coordinates.

Options include:

- Preserving seam boundaries
- Controlling smoothing iterations
- Re-normalizing UVs after relaxation

### Repack Atlas

Regenerates the atlas using current chart and padding settings.

---

## Export Features

### Download Unwrapped OBJ

Exports the current model as an `.obj` file with generated UV coordinates.

### Export UV Report

Exports a `.json` report containing:

- Generation timestamp
- Current unwrap mode
- Correction exponent
- Chart count
- Face count
- Vertex count
- Distortion score
- Area distortion
- Angle error
- Flipped triangle count
- Seam length
- UV utilization

### Capture Screenshot

Downloads a PNG screenshot of the current 3D viewport.

---

## UI Features

- Dark / light mode toggle
- Floating control panel
- UV atlas preview panel
- Metrics panel
- FPS counter
- Camera position debug panel
- Expandable debug log
- Built-in help chat widget
- Animated panel entrance
- Responsive layout for smaller screens

---

## Technologies Used

- **HTML5**
- **CSS3**
- **JavaScript**
- **Three.js**
- **OrbitControls**
- **OBJLoader**
- **OBJExporter**
- **BufferGeometryUtils**
- **Chart.js**
- **anime.js**

---

## Getting Started

### 1. Clone or Download

```bash
git clone https://github.com/your-username/advanced-3d-uv-toolkit.git
cd advanced-3d-uv-toolkit
````

### 2. Open the App

Because this is a browser-based project, you can open the HTML file directly:

```bash
index.html
```

For best results, run it through a local development server:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

---

## How to Use

1. Open the app in a modern browser.
2. Load an `.obj` model using the file picker or drag-and-drop area.
3. Choose an unwrap mode:

   * Advanced Atlas for general use
   * Box / Triplanar for hard-surface models
   * Spherical for round models
   * Cylindrical for tubes or bottles
   * Planar for flat meshes
4. Adjust advanced options if needed:

   * Correction exponent
   * Smoothing iterations
   * Chart split detail
   * Atlas padding
   * Seam curvature threshold
5. Click **Auto UV Unwrap**.
6. Inspect the result using:

   * Checker texture
   * UV atlas preview
   * Distortion heatmap
   * Seam overlay
   * Metrics dashboard
7. Click **Optimize** to search for improved settings.
8. Export the result as an OBJ file or JSON report.

---

## Controls Overview

| Control        | Purpose                               |
| -------------- | ------------------------------------- |
| Load Model     | Opens an OBJ file                     |
| Auto UV Unwrap | Generates UVs using selected mode     |
| Optimize       | Searches for improved unwrap settings |
| Relax UV       | Smooths UV coordinates                |
| Repack Atlas   | Rebuilds chart layout                 |
| Download OBJ   | Exports the unwrapped model           |
| Export Report  | Saves UV metrics as JSON              |
| Reset Model    | Restores the default sphere           |
| Screenshot     | Captures the viewport                 |
| Reset Camera   | Fits the camera to the model          |
| Toggle Grid    | Shows or hides the floor grid         |
| Wireframe      | Toggles wireframe rendering           |
| Turntable      | Rotates the model automatically       |

---

## Advanced Settings

### Correction Exponent

Controls how strongly the advanced projection adjusts radial distortion.

Lower values can spread UVs differently across curved surfaces, while higher values may preserve some areas more strongly.

### Smoothing Iterations

Controls how many UV relaxation passes are applied.

More iterations may smooth distortion, but too many can shrink or blur UV islands.

### Chart Split Detail

Controls how aggressively the mesh is divided into charts.

Higher values can reduce stretching but may create more seams.

### Atlas Padding

Adds spacing between UV islands.

Useful for texture baking, mipmapping, and reducing bleeding between islands.

### Smart Seam Curvature Threshold

Controls how aggressively the toolkit creates seams around high-curvature areas.

Lower values create fewer seams.
Higher values create more chart splits.

---

## Project Goals

This project is intended to explore:

* Browser-based UV unwrapping
* Visual UV debugging
* Lightweight chart generation
* Atlas packing experiments
* Texture stretching analysis
* Seam placement heuristics
* Educational geometry processing
* Exportable OBJ workflows

It is not intended to fully replace Blender, Maya, RizomUV, Houdini, or production-grade UV solvers. Instead, it provides a fast experimental environment for understanding and testing UV ideas.

---

## Current Limitations

* OBJ is currently the primary supported import/export format.
* The advanced atlas mode is an approximation, not a full xatlas, LSCM, ABF++, or SLIM implementation.
* UV packing is grid/cell based rather than a full irregular bin-packing algorithm.
* Seam detection is heuristic-based.
* Materials from imported OBJ files are not fully preserved.
* Large meshes may be slow because everything runs on the main browser thread.
* Distortion metrics are approximate and designed for comparison rather than exact scientific validation.

---

## Suggested Future Improvements

* Add GLTF / GLB import and export
* Add STL import for 3D printing workflows
* Add real LSCM-style parameterization
* Add ABF++ or conformal flattening experiments
* Add Web Worker support for heavy meshes
* Add WebGPU acceleration
* Add island rotation optimization
* Add better irregular atlas packing
* Add texture bake preview
* Add UV island selection and manual editing
* Add seam painting tools
* Add pinned vertices
* Add unwrap presets
* Add material and MTL export support
* Add save/load project files
* Add comparison mode between unwrap strategies
* Add automatic screenshot/report bundles

---

## Research-Inspired Direction

The toolkit takes inspiration from modern mesh parameterization and atlas workflows, especially:

* Chart-based UV atlas generation
* Seam-aware parameterization
* Texture stretch visualization
* Angle and area distortion metrics
* Checker-map validation
* Atlas utilization scoring
* Part-aware and visibility-aware UV organization ideas

The goal is to make these concepts interactive and understandable inside a single browser page.

---

## Browser Compatibility

Recommended browsers:

* Google Chrome
* Microsoft Edge
* Brave
* Firefox

A browser with WebGL support is required.

---

## File Structure

Example simple project structure:

```text
advanced-3d-uv-toolkit/
├── index.html
├── README.md
└── screenshots/
    ├── viewport.png
    └── uv-atlas.png
```

---

## Screenshots

Add screenshots here once available:

```markdown
![3D viewport](screenshots/viewport.png)
![UV atlas preview](screenshots/uv-atlas.png)
```

---

## Development Notes

The main class is:

```js
class UVToolkit
```

Important responsibilities:

| Method                 | Purpose                               |
| ---------------------- | ------------------------------------- |
| `loadModel()`          | Loads and parses OBJ files            |
| `buildUVForGeometry()` | Generates UV coordinates              |
| `unwrap()`             | Runs the selected unwrap workflow     |
| `relaxUV()`            | Smooths UV coordinates                |
| `calculateMetrics()`   | Computes UV quality metrics           |
| `computeSeams()`       | Detects seam edges                    |
| `drawUVPreview()`      | Draws UV layout to canvas             |
| `applyHeatmap()`       | Applies distortion colors to the mesh |
| `optimizeUnwrap()`     | Searches for better unwrap settings   |
| `downloadModel()`      | Exports OBJ                           |
| `exportReport()`       | Exports JSON metrics                  |

---

## Safety and Privacy

The toolkit runs fully in the browser.

* Models are loaded locally.
* No upload server is required.
* No account is needed.
* No model data is sent anywhere by default.
* Exported files are generated locally in the browser.

---

## License

Choose a license for your project.

Example:

```text
MIT License
```

---

## Author

Created by **kai9987kai**

An experimental browser-based UV unwrapping, visualization, and geometry-processing toolkit for creative 3D workflows.

```
```
