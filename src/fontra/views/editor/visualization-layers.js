import { enumerate, withSavedState } from "/core/utils.js";
import { mulScalar } from "/core/var-funcs.js";

export class VisualizationLayers {
  constructor(darkTheme, definitions) {
    this.darkTheme = darkTheme;
    this.definitions = definitions ? definitions : visualizationLayerDefinitions;
    this.scaleFactor = 1;
    this.layers = [];
    this.visibleLayerIds = new Set(
      this.definitions
        .filter((layer) => !layer.userSwitchable)
        .map((layer) => layer.identifier)
    );
  }

  buildLayers() {
    const layers = [];
    for (const layerDef of this.definitions) {
      if (!this.visibleLayerIds.has(layerDef.identifier)) {
        continue;
      }
      const parameters = {
        ...mulScalar(layerDef.screenParameters || {}, this.scaleFactor),
        ...(layerDef.glyphParameters || {}),
        ...(layerDef.colors || {}),
        ...(this.darkTheme && layerDef.colorsDarkMode ? layerDef.colorsDarkMode : {}),
      };
      const layer = {
        selectionMode: layerDef.selectionMode,
        parameters: parameters,
        draw: layerDef.draw,
      };
      layers.push(layer);
    }
    this.layers = layers;
  }

  drawVisualizationLayers(model, controller) {
    const glyphsBySelectionMode = getGlyphsBySelectionMode(model);
    const context = controller.context;
    for (const layer of this.layers) {
      for (const positionedGlyph of glyphsBySelectionMode[layer.selectionMode]) {
        withSavedState(context, () => {
          context.translate(positionedGlyph.x, positionedGlyph.y);
          layer.draw(context, positionedGlyph, layer.parameters, model, controller);
        });
      }
    }
  }
}

function getGlyphsBySelectionMode(model) {
  const selectedPositionedGlyph = model.getSelectedPositionedGlyph();
  const allPositionedGlyphs = model.positionedLines.flatMap((line) => line.glyphs);
  return {
    all: allPositionedGlyphs,
    unselected: allPositionedGlyphs.filter(
      (glyph) => glyph !== selectedPositionedGlyph
    ),
    hovered:
      model.hoveredGlyph && model.hoveredGlyph !== model.selectedGlyph
        ? [model.getHoveredPositionedGlyph()]
        : [],
    selected:
      model.selectedGlyph && !model.selectedGlyphIsEditing
        ? [model.getSelectedPositionedGlyph()]
        : [],
    editing: model.selectedGlyphIsEditing ? [model.getSelectedPositionedGlyph()] : [],
  };
}

const visualizationLayerDefinitions = [];

export function registerVisualizationLayerDefinition(newLayerDef) {
  let index = -1;
  let layerDef;
  for ([index, layerDef] of enumerate(visualizationLayerDefinitions)) {
    if (newLayerDef.zIndex > layerDef.zIndex) {
      break;
    }
  }
  visualizationLayerDefinitions.splice(index + 1, 0, newLayerDef);
}

registerVisualizationLayerDefinition({
  identifier: "fontra.baseline",
  name: "Baseline",
  selectionMode: "editing",
  userSwitchable: true,
  zIndex: 500,
  screenParameters: { strokeWidth: 1 },
  colors: { strokeColor: "#0004" },
  colorsDarkMode: { strokeColor: "#FFF6" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    context.strokeStyle = parameters.strokeColor;
    context.lineWidth = parameters.strokeWidth;
    strokeLine(context, 0, 0, positionedGlyph.glyph.xAdvance, 0);
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.empty.selected.glyph",
  name: "Empty selected glyph",
  selectionMode: "selected",
  zIndex: 500,
  colors: { fillColor: "#D8D8D8" /* Must be six hex digits */ },
  colorsDarkMode: { fillColor: "#585858" /* Must be six hex digits */ },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    _drawEmptyGlyphLayer(context, positionedGlyph, parameters, model, controller);
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.empty.hovered.glyph",
  name: "Empty hovered glyph",
  selectionMode: "hovered",
  zIndex: 500,
  colors: { fillColor: "#E8E8E8" /* Must be six hex digits */ },
  colorsDarkMode: { fillColor: "#484848" /* Must be six hex digits */ },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    _drawEmptyGlyphLayer(context, positionedGlyph, parameters, model, controller);
  },
});

function _drawEmptyGlyphLayer(context, positionedGlyph, parameters, model, controller) {
  if (!positionedGlyph.isEmpty) {
    return;
  }
  const box = positionedGlyph.unpositionedBounds;
  const fillColor = parameters.fillColor;
  if (fillColor[0] === "#" && fillColor.length === 7) {
    const gradient = context.createLinearGradient(0, box.yMin, 0, box.yMax);
    gradient.addColorStop(0.0, fillColor + "00");
    gradient.addColorStop(0.2, fillColor + "DD");
    gradient.addColorStop(0.5, fillColor + "FF");
    gradient.addColorStop(0.8, fillColor + "DD");
    gradient.addColorStop(1.0, fillColor + "00");
    context.fillStyle = gradient;
  } else {
    context.fillStyle = fillColor;
  }
  context.fillRect(box.xMin, box.yMin, box.xMax - box.xMin, box.yMax - box.yMin);
}

registerVisualizationLayerDefinition({
  identifier: "fontra.context.glyphs",
  name: "Context glyphs",
  selectionMode: "unselected",
  zIndex: 500,
  colors: { fillColor: "#000" },
  colorsDarkMode: { fillColor: "#FFF" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    context.fillStyle = parameters.fillColor;
    context.fill(positionedGlyph.glyph.flattenedPath2d);
  },
});

registerVisualizationLayerDefinition({
  identifier: "fontra.cjk.design.frame",
  name: "CJK Design Frame glyphs",
  selectionMode: "editing",
  zIndex: 500,
  colors: {
    strokeColor: "#0004",
    overshootColor: "#00BFFF26",
    secondLineColor: "#A6296344",
  },
  colorsDarkMode: {
    strokeColor: "#FFF6",
    secondLineColor: "#A62963AA",
  },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    const cjkDesignFrameParameters =
      model.fontController.fontLib["CJKDesignFrameSettings"];
    if (!cjkDesignFrameParameters) {
      return;
    }
    const [emW, emH] = cjkDesignFrameParameters["em_Dimension"];
    const characterFace = cjkDesignFrameParameters["characterFace"] / 100;
    const [shiftX, shiftY] = cjkDesignFrameParameters["shift"] || [0, -120];
    const [overshootInside, overshootOutside] = cjkDesignFrameParameters["overshoot"];
    const [faceW, faceH] = [emW * characterFace, emH * characterFace];
    const [faceX, faceY] = [(emW - faceW) / 2, (emH - faceH) / 2];
    let horizontalLine = cjkDesignFrameParameters["horizontalLine"];
    let verticalLine = cjkDesignFrameParameters["verticalLine"];
    const [overshootInsideW, overshootInsideH] = [
      faceW - overshootInside * 2,
      faceH - overshootInside * 2,
    ];
    const [overshootOutsideW, overshootOutsideH] = [
      faceW + overshootOutside * 2,
      faceH + overshootOutside * 2,
    ];

    context.translate(shiftX, shiftY);

    context.strokeStyle = parameters.strokeColor;
    context.lineWidth = parameters.cjkFrameLineWidth;
    context.strokeRect(0, 0, emW, emH);
    context.strokeRect(faceX, faceY, faceW, faceH);

    context.strokeStyle = parameters.secondLineColor;
    if (cjkDesignFrameParameters["type"] === "han") {
      horizontalLine /= 100;
      verticalLine /= 100;
      const centerX = emW / 2;
      const centerY = emH / 2;
      for (const y of [
        centerY + emH * horizontalLine,
        centerY - emH * horizontalLine,
      ]) {
        strokeLine(context, 0, y, emW, y);
      }
      for (const x of [centerX + emW * verticalLine, centerX - emW * verticalLine]) {
        strokeLine(context, x, 0, x, emH);
      }
    } else {
      // hangul
      const stepX = faceW / verticalLine;
      const stepY = faceH / horizontalLine;
      for (let i = 1; i < horizontalLine; i++) {
        const y = faceY + i * stepY;
        strokeLine(context, faceX, y, faceX + faceW, y);
      }
      for (let i = 1; i < verticalLine; i++) {
        const x = faceX + i * stepX;
        strokeLine(context, x, faceY, x, faceY + faceH);
      }
    }

    // overshoot rect
    context.fillStyle = parameters.overshootColor;
    context.beginPath();
    context.rect(
      faceX - overshootOutside,
      faceY - overshootOutside,
      overshootOutsideW,
      overshootOutsideH
    );
    context.rect(
      faceX + overshootInside,
      faceY + overshootInside,
      overshootInsideW,
      overshootInsideH
    );
    context.fill("evenodd");
  },
});

export const allGlyphsCleanVisualizationLayerDefinition = {
  identifier: "fontra.all.glyphs",
  name: "All glyphs",
  selectionMode: "all",
  zIndex: 500,
  colors: { fillColor: "#000" },
  colorsDarkMode: { fillColor: "#FFF" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    context.fillStyle = parameters.fillColor;
    context.fill(positionedGlyph.glyph.flattenedPath2d);
  },
};

// Duplicated from scene-draw-funcs.js -- move to new module drawing-tools.js ?
function strokeLine(context, x1, y1, x2, y2) {
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
}

// {
//   identifier: "fontra.baseline",
//   name: "Baseline",
//   selectionMode: "unselected",  // choice from all, unselected, hovered, selected, editing
//   zIndex: 50
//   screenParameters: {},  // in screen/pixel units
//   glyphParameters: {},  // in glyph units
//   colors: {},
//   colorsDarkMode: {},
//   draw: (context, positionedGlyph, parameters, model, controller) => { /* ... */ },
// }
