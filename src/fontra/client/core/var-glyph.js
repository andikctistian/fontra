import { VarPackedPath } from "./var-path.js";

export class VariableGlyph {
  static fromObject(obj) {
    const glyph = new VariableGlyph();
    glyph.name = obj.name;
    glyph.axes =
      obj.axes?.map((axis) => {
        return { ...axis };
      }) || [];
    glyph.sources = obj.sources.map((source) => Source.fromObject(source));
    glyph.layers = Object.fromEntries(
      Object.entries(obj.layers).map(([name, layer]) => [name, Layer.fromObject(layer)])
    );
    glyph.customData = copyCustomData(obj.customData || {});
    return glyph;
  }

  copy() {
    return VariableGlyph.fromObject(this);
  }
}

export class Layer {
  static fromObject(obj) {
    const layer = new Layer();
    layer.glyph = StaticGlyph.fromObject(obj.glyph);
    layer.customData = copyCustomData(obj.customData || {});
    return layer;
  }
}

export class Source {
  static fromObject(obj) {
    const source = new Source();
    source.name = obj.name;
    source.location = { ...obj.location } || {};
    source.layerName = obj.layerName;
    source.inactive = !!obj.inactive;
    source.customData = copyCustomData(obj.customData || {});
    return source;
  }
}

export class StaticGlyph {
  static fromObject(obj) {
    const source = new StaticGlyph();
    source.xAdvance = obj.xAdvance;
    source.yAdvance = obj.yAdvance;
    source.verticalOrigin = obj.verticalOrigin;
    if (obj.path) {
      source.path = VarPackedPath.fromObject(obj.path);
    } else {
      source.path = new VarPackedPath();
    }
    source.components = obj.components?.map(copyComponent) || [];
    return source;
  }

  copy() {
    return StaticGlyph.fromObject(this);
  }
}

function copyComponent(component) {
  return {
    name: component.name,
    transformation: { ...component.transformation },
    location: { ...component.location },
  };
}

function copyCustomData(data) {
  return JSON.parse(JSON.stringify(data));
}
