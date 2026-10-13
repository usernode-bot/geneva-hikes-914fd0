# Geneva hikes icons

The mark is a **hiking boot stepping toward a mountain peak** — flat, no
text, in the Homeroom brand framework's Icons-tile style (one bold mark
on a rounded-square tile). The tile rounds and crops the square PNG, so
the SVGs are full bleed with no rounded corners and keep the mark inside
roughly the middle 80% of the canvas.

## Files

| File | What it is |
| --- | --- |
| `icon.svg` / `icon.png` | **The app icon.** Declared as `icon.image` in `dapp.json` (the `icon.emoji` boot emoji stays as the fallback). Rendered at 1024×1024, opaque. |
| `icon-light.svg` / `icon-light.png` | **Featured icon, light version** — the same boot and peak with a smaller foothill behind and a dotted trail from the boot up toward the summit (it echoes the trailhead-to-stop dotted line in the app), on a cream ground. Used for the Homeroom directory listing. |
| `icon-dark.svg` / `icon-dark.png` | **Featured icon, dark version** — same picture on a black ground, with the boot, trail dots and outlines in cream. |

## Colours (brand palette only)

| Colour | Hex | Role |
| --- | --- | --- |
| Cream | `#FFFEEA` | Tile / ground (app icon and featured light); boot, dots and outlines on the dark version |
| Black | `#000000` | Boot, ground line and outlines on cream; dark ground |
| Green | `#A9CF97` | Peak fill (Black + Green / Cream + Black brand pairings) |

## Redrawing

Edit the SVG, then re-render the matching PNG at 1024×1024:

```sh
rsvg-convert -w 1024 -h 1024 icon.svg -o icon.png
```

(If `rsvg-convert` is not installed, the headless Chromium in
`~/.cache/ms-playwright` can screenshot the SVG at a 1024×1024
viewport.) Only the three hex values above may appear as fills or
strokes; the mark must stay legible at 32 px on both light and dark
surroundings.
