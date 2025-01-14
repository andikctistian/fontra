import { getAxisBaseName } from "/core/glyph-controller.js";
import { ObservableController } from "/core/observable-object.js";
import { Layer, Source } from "/core/var-glyph.js";
import * as html from "/core/unlit.js";
import {
  enumerate,
  htmlToElement,
  objectsEqual,
  rgbaToCSS,
  scheduleCalls,
} from "/core/utils.js";
import {
  locationToString,
  normalizeLocation,
  piecewiseLinearMap,
  mapForward,
} from "/core/var-model.js";
import { dialogSetup } from "/web-components/dialog-overlay.js";
import { showMenu } from "/web-components/menu-panel.js";

const FONTRA_STATUS_KEY = "fontra.development.status";
const FONTRA_STATUS_DEFINITIONS_KEY = "fontra.sourceStatusFieldDefinitions";

export class SidebarDesignspace {
  constructor(sceneController, dataController) {
    this.sceneController = sceneController;
    this.dataController = dataController;
    this.dataModel = dataController.model;
  }

  async setup() {
    this.dataController.addKeyListener("varGlyphController", (key, newValue) => {
      this._updateAxes();
      this._updateSources();
      this._updateSelectedSourceFromLocation();
    });

    this.axisSliders = document.querySelector("#designspace-location");
    this.axisSliders.values = this.dataModel.location;

    this.axisSliders.addEventListener(
      "locationChanged",
      scheduleCalls(async (event) => {
        this.dataModel.location = { ...this.axisSliders.values };
      })
    );

    this.dataController.addKeyListener("location", (key, newLocation) => {
      this.axisSliders.values = newLocation;
      this._updateSelectedSourceFromLocation();
      this._updateRemoveSourceButtonState();
    });

    const columnDescriptions = [
      {
        title: "on",
        key: "active",
        cellFactory: checkboxListCell,
        width: "2em",
      },
      { key: "name", title: "Source name", width: "12em" },
      {
        title: "bg",
        key: "visible",
        cellFactory: checkboxListCell,
        width: "2em",
      },
    ];
    const statusFieldDefinitions =
      this.sceneController.sceneModel.fontController.fontLib[
        FONTRA_STATUS_DEFINITIONS_KEY
      ];
    if (statusFieldDefinitions) {
      this.defaultStatusValue = statusFieldDefinitions.find(
        (statusDef) => statusDef.isDefault
      )?.value;
      columnDescriptions.push({
        title: "status",
        key: "status",
        cellFactory: statusListCell,
        width: "3em",
        statusFieldDefinitions: statusFieldDefinitions,
        menuItems: statusFieldDefinitions.map((statusDef) => {
          return {
            title: statusDef.label,
            enabled: () => true,
            statusDef: statusDef,
          };
        }),
      });
    }
    this.sourcesList = document.querySelector("#sources-list");
    this.sourcesList.showHeader = true;
    this.sourcesList.columnDescriptions = columnDescriptions;

    this.addRemoveSourceButtons = document.querySelector(
      "#sources-list-add-remove-buttons"
    );
    this.addRemoveSourceButtons.addButtonCallback = () => this.addSource();
    this.addRemoveSourceButtons.removeButtonCallback = () =>
      this.removeSource(this.sourcesList.getSelectedItemIndex());
    this.addRemoveSourceButtons.hidden = true;

    this.sourcesList.addEventListener("listSelectionChanged", async (event) => {
      this._updateLocationFromSelectedSource();
    });

    this.sourcesList.addEventListener("rowDoubleClicked", (event) => {
      this.editSourceProperties(event.detail.doubleClickedRowIndex);
    });

    this._updateAxes();
    this._updateSources();
    this._updateSelectedSourceFromLocation();
  }

  forceUpdateSources() {
    this._updateSources();
  }

  _updateAxes() {
    const axes = [...this.dataModel.globalAxes];
    const globalAxisNames = new Set(axes.map((axis) => axis.name));
    const localAxes = getAxisInfoFromGlyph(this.dataModel.varGlyphController).filter(
      (axis) => !globalAxisNames.has(axis.name)
    );
    if (localAxes.length) {
      if (axes.length) {
        axes.push({ isDivider: true });
      }
      axes.push(...localAxes);
    }
    this.axisSliders.axes = axes;
  }

  _updateSources() {
    const varGlyphController = this.dataModel.varGlyphController;
    const sources = varGlyphController?.sources || [];
    let backgroundLayers = { ...this.sceneController.backgroundLayers };
    const sourceItems = [];
    for (const [index, source] of enumerate(sources)) {
      const layerName = source.layerName;
      const status = source.customData[FONTRA_STATUS_KEY];
      const sourceController = new ObservableController({
        name: source.name,
        active: !source.inactive,
        visible: backgroundLayers[layerName] === source.name,
        status: status !== undefined ? status : this.defaultStatusValue,
      });
      sourceController.addKeyListener("active", async (key, newValue) => {
        await this.sceneController.editGlyphAndRecordChanges((glyph) => {
          glyph.sources[index].inactive = !newValue;
          return `${newValue ? "" : "de"}activate ${source.name}`;
        });
      });
      sourceController.addKeyListener("visible", async (key, newValue) => {
        if (newValue) {
          backgroundLayers[layerName] = source.name;
        } else {
          delete backgroundLayers[layerName];
        }
        this.sceneController.backgroundLayers = backgroundLayers;
      });
      sourceController.addKeyListener("status", async (key, newValue) => {
        await this.sceneController.editGlyphAndRecordChanges((glyph) => {
          glyph.sources[index].customData[FONTRA_STATUS_KEY] = newValue;
          return `set status ${source.name}`;
        });
      });
      sourceItems.push(sourceController.model);
    }
    this.sourcesList.setItems(sourceItems);
    this.addRemoveSourceButtons.hidden = !sourceItems.length;
    this.addRemoveSourceButtons.disableAddButton = !this.axisSliders.axes.length;
  }

  _updateSelectedSourceFromLocation() {
    const sourceIndex = this.dataModel.varGlyphController?.getSourceIndex(
      this.dataModel.location
    );
    this.sourcesList.setSelectedItemIndex(sourceIndex);
  }

  _updateLocationFromSelectedSource() {
    const sourceIndex = this.sourcesList.getSelectedItemIndex();
    if (sourceIndex === undefined) {
      return;
    }
    this.dataModel.location =
      this.dataModel.varGlyphController.mapSourceLocationToGlobal(sourceIndex);
  }

  _updateRemoveSourceButtonState() {
    this.addRemoveSourceButtons.disableRemoveButton =
      this.sourcesList.getSelectedItemIndex() === undefined;
  }

  async removeSource(sourceIndex) {
    if (sourceIndex === undefined) {
      return;
    }
    const glyphController = this.dataModel.varGlyphController;
    const glyph = glyphController.glyph;
    const source = glyph.sources[sourceIndex];
    const dialog = await dialogSetup("Delete source", null, [
      { title: "Cancel", isCancelButton: true },
      { title: "Delete", isDefaultButton: true, result: "ok" },
    ]);

    const canDeleteLayer =
      1 ===
      glyph.sources.reduce(
        (count, src) => count + (src.layerName === source.layerName ? 1 : 0),
        0
      );
    const deleteLayerCheckBox = html.input({
      type: "checkbox",
      id: "delete-layer",
      checked: canDeleteLayer,
      disabled: !canDeleteLayer,
    });

    const dialogContent = html.div({}, [
      html.div({ class: "message" }, [
        `Are you sure you want to delete source #${sourceIndex}, “${source.name}”?`,
      ]),
      html.br(),
      deleteLayerCheckBox,
      html.label({ for: "delete-layer", style: canDeleteLayer ? "" : "color: gray;" }, [
        `Also delete associated layer “${source.layerName}”`,
      ]),
    ]);
    dialog.setContent(dialogContent);

    if (!(await dialog.run())) {
      return;
    }

    const layer = glyph.layers[source.layerName];
    await this.sceneController.editGlyphAndRecordChanges((glyph) => {
      glyph.sources.splice(sourceIndex, 1);
      let layerMessage = "";
      if (layer !== undefined && deleteLayerCheckBox.checked) {
        delete glyph.layers[source.layerName];
        layerMessage = " and layer";
      }
      return "delete source" + layerMessage;
    });
    // Update UI
    await this._updateSources();
  }

  async addSource() {
    const glyphController = this.dataModel.varGlyphController;
    const glyph = glyphController.glyph;

    const location = glyphController.mapLocationGlobalToLocal(this.dataModel.location);

    const {
      location: newLocation,
      sourceName,
      layerName,
      layerNames,
    } = await this._sourcePropertiesRunDialog(
      "Add source",
      "Add",
      glyph,
      "",
      "",
      location
    );
    if (!newLocation) {
      return;
    }
    const instance = glyphController
      .instantiate(normalizeLocation(newLocation, glyphController.combinedAxes))
      .copy();
    // Round coordinates and component positions
    instance.path = instance.path.roundCoordinates();
    roundComponentOrigins(instance.components);

    await this.sceneController.editGlyphAndRecordChanges((glyph) => {
      glyph.sources.push(
        Source.fromObject({
          name: sourceName,
          layerName: layerName,
          location: newLocation,
        })
      );
      if (layerNames.indexOf(layerName) < 0) {
        // Only add layer if the name is new
        glyph.layers[layerName] = Layer.fromObject({ glyph: instance });
      }
      return "add source";
    });
    // Update UI
    await this._updateSources();
    const selectedSourceIndex = glyph.sources.length - 1; /* the newly added source */
    this.sourcesList.setSelectedItemIndex(selectedSourceIndex);
    this._updateLocationFromSelectedSource();
  }

  async editSourceProperties(sourceIndex) {
    const glyphController = this.dataModel.varGlyphController;
    const glyph = glyphController.glyph;

    const source = glyph.sources[sourceIndex];

    const {
      location: newLocation,
      sourceName,
      layerName,
      layerNames,
    } = await this._sourcePropertiesRunDialog(
      "Source properties",
      "Done",
      glyph,
      source.name,
      source.layerName,
      source.location
    );
    if (!newLocation) {
      return;
    }

    await this.sceneController.editGlyphAndRecordChanges((glyph) => {
      const source = glyph.sources[sourceIndex];
      if (!objectsEqual(source.location, newLocation)) {
        source.location = newLocation;
      }
      if (sourceName !== source.name) {
        source.name = sourceName;
      }
      const oldLayerName = source.layerName;
      if (layerName !== oldLayerName) {
        source.layerName = layerName;
        if (layerNames.indexOf(layerName) < 0) {
          // Rename the layer
          if (glyph.layers[oldLayerName]) {
            glyph.layers[layerName] = glyph.layers[oldLayerName];
            delete glyph.layers[oldLayerName];
          }
          for (const source of glyph.sources) {
            if (source.layerName === oldLayerName) {
              source.layerName = layerName;
            }
          }
        }
      }
      return "edit source properties";
    });
    // Update UI
    await this._updateSources();
    this.sourcesList.setSelectedItemIndex(sourceIndex);
    this._updateLocationFromSelectedSource();
  }

  async _sourcePropertiesRunDialog(
    title,
    okButtonTitle,
    glyph,
    sourceName,
    layerName,
    location
  ) {
    const validateInput = () => {
      const warnings = [];
      const editedSourceName =
        nameController.model.sourceName || nameController.model.suggestedSourceName;
      if (!editedSourceName.length) {
        warnings.push("⚠️ The source name must not be empty");
      } else if (
        editedSourceName !== sourceName &&
        glyph.sources.some((source) => source.name === editedSourceName)
      ) {
        warnings.push("⚠️ The source name should be unique");
      }
      const locStr = locationToString(
        makeSparseLocation(locationController.model, locationAxes)
      );
      if (sourceLocations.has(locStr)) {
        warnings.push("⚠️ The source location must be unique");
      }
      warningElement.innerText = warnings.length ? warnings.join("\n") : "";
      dialog.defaultButton.classList.toggle("disabled", warnings.length);
    };

    const locationAxes = this._sourcePropertiesLocationAxes(glyph);
    const locationController = new ObservableController({ ...location });
    const layerNames = Object.keys(glyph.layers);
    const suggestedSourceName = suggestedSourceNameFromLocation(
      makeSparseLocation(location, locationAxes)
    );

    const nameController = new ObservableController({
      sourceName: sourceName || suggestedSourceName,
      layerName: layerName === sourceName ? "" : layerName,
      suggestedSourceName: suggestedSourceName,
      suggestedLayerName: sourceName || suggestedSourceName,
    });

    nameController.addKeyListener("sourceName", (key, newValue) => {
      nameController.model.suggestedLayerName =
        newValue || nameController.model.suggestedSourceName;
      validateInput();
    });

    locationController.addListener((key, newValue) => {
      const suggestedSourceName = suggestedSourceNameFromLocation(
        makeSparseLocation(locationController.model, locationAxes)
      );
      if (nameController.model.sourceName == nameController.model.suggestedSourceName) {
        nameController.model.sourceName = suggestedSourceName;
      }
      if (nameController.model.layerName == nameController.model.suggestedSourceName) {
        nameController.model.layerName = suggestedSourceName;
      }
      nameController.model.suggestedSourceName = suggestedSourceName;
      nameController.model.suggestedLayerName =
        nameController.model.sourceName || suggestedSourceName;
      validateInput();
    });

    const sourceLocations = new Set(
      glyph.sources.map((source) =>
        locationToString(makeSparseLocation(source.location, locationAxes))
      )
    );
    if (sourceName.length) {
      sourceLocations.delete(
        locationToString(makeSparseLocation(location, locationAxes))
      );
    }

    const { contentElement, warningElement } = this._sourcePropertiesContentElement(
      locationAxes,
      nameController,
      locationController,
      layerNames,
      sourceLocations
    );

    const dialog = await dialogSetup(title, null, [
      { title: "Cancel", isCancelButton: true },
      { title: okButtonTitle, isDefaultButton: true, disabled: !sourceName.length },
    ]);
    dialog.setContent(contentElement);

    setTimeout(() => contentElement.querySelector(`#sourceName`)?.focus(), 0);

    validateInput();

    if (!(await dialog.run())) {
      // User cancelled
      return {};
    }

    const newLocation = makeSparseLocation(locationController.model, locationAxes);

    sourceName =
      nameController.model.sourceName || nameController.model.suggestedSourceName;
    layerName =
      nameController.model.layerName || nameController.model.suggestedLayerName;

    return { location: newLocation, sourceName, layerName, layerNames };
  }

  _sourcePropertiesLocationAxes(glyph) {
    const localAxisNames = glyph.axes.map((axis) => axis.name);
    const globalAxes = mapAxesFromUserSpaceToDesignspace(
      // Don't include global axes that also exist as local axes
      this.dataModel.globalAxes.filter((axis) => !localAxisNames.includes(axis.name))
    );
    return [
      ...globalAxes,
      ...(globalAxes.length && glyph.axes.length ? [{ isDivider: true }] : []),
      ...glyph.axes,
    ];
  }

  _sourcePropertiesContentElement(
    locationAxes,
    nameController,
    locationController,
    layerNames,
    sourceLocations
  ) {
    const locationElement = html.createDomElement("designspace-location", {
      style: `grid-column: 1 / -1;
        min-height: 0;
        overflow: scroll;
        height: 100%;
      `,
    });
    const warningElement = html.div({
      id: "warning-text",
      style: `grid-column: 1 / -1; min-height: 1.5em;`,
    });
    locationElement.axes = locationAxes;
    locationElement.controller = locationController;
    const contentElement = html.div(
      {
        style: `overflow: hidden;
          white-space: nowrap;
          display: grid;
          gap: 0.5em;
          grid-template-columns: max-content auto;
          align-items: center;
          height: 100%;
          min-height: 0;
        `,
      },
      [
        ...labeledTextInput("Source name:", nameController, "sourceName", {
          placeholderKey: "suggestedSourceName",
        }),
        ...labeledTextInput("Layer:", nameController, "layerName", {
          placeholderKey: "suggestedLayerName",
          choices: layerNames,
        }),
        html.br(),
        locationElement,
        warningElement,
      ]
    );
    return { contentElement, warningElement };
  }
}

function mapAxesFromUserSpaceToDesignspace(axes) {
  return axes.map((axis) => {
    const newAxis = { ...axis };
    if (axis.mapping) {
      for (const prop of ["minValue", "defaultValue", "maxValue"]) {
        newAxis[prop] = piecewiseLinearMap(
          axis[prop],
          Object.fromEntries(axis.mapping)
        );
      }
    }
    return newAxis;
  });
}

function* labeledTextInput(label, controller, key, options) {
  yield html.label({ for: key, style: "text-align: right;" }, [label]);

  const choices = options?.choices;
  const choicesID = `${key}-choices`;

  const inputElement = htmlToElement(`<input ${choices ? `list="${choicesID}"` : ""}>`);
  inputElement.type = "text";
  inputElement.id = key;
  inputElement.value = controller.model[key];
  inputElement.oninput = () => (controller.model[key] = inputElement.value);

  controller.addKeyListener(key, (key, newValue) => (inputElement.value = newValue));

  if (options && options.placeholderKey) {
    inputElement.placeholder = controller.model[options.placeholderKey];
    controller.addKeyListener(
      options.placeholderKey,
      (key, newValue) => (inputElement.placeholder = newValue)
    );
  }

  yield inputElement;

  if (choices) {
    yield html.createDomElement(
      "datalist",
      { id: choicesID },
      choices.map((item) => html.createDomElement("option", { value: item }))
    );
  }
}

function roundComponentOrigins(components) {
  components.forEach((component) => {
    component.transformation.translateX = Math.round(
      component.transformation.translateX
    );
    component.transformation.translateY = Math.round(
      component.transformation.translateY
    );
  });
}

function makeSparseLocation(location, axes) {
  return Object.fromEntries(
    axes
      .filter(
        (axis) =>
          location[axis.name] !== undefined && location[axis.name] !== axis.defaultValue
      )
      .map((axis) => [axis.name, location[axis.name]])
  );
}

function getAxisInfoFromGlyph(glyph) {
  const axisInfo = {};
  for (const axis of glyph?.axes || []) {
    const baseName = getAxisBaseName(axis.name);
    if (axisInfo[baseName]) {
      continue;
    }
    axisInfo[baseName] = { ...axis, name: baseName };
  }
  return Object.values(axisInfo);
}

function suggestedSourceNameFromLocation(location) {
  return (
    Object.entries(location)
      .map(([name, value]) => {
        value = Math.round(value * 10) / 10;
        return `${name}=${value}`;
      })
      .join(",") || "default"
  );
}

function checkboxListCell(item, colDesc) {
  const value = item[colDesc.key];
  return html.input({
    type: "checkbox",
    style: `width: auto; margin: 0; padding: 0; outline: none;`,
    checked: value,
    onclick: (event) => {
      item[colDesc.key] = event.target.checked;
      event.stopImmediatePropagation();
    },
    ondblclick: (event) => {
      event.stopImmediatePropagation();
    },
  });
}

function statusListCell(item, colDesc) {
  const value = item[colDesc.key];
  let color;
  for (const statusDef of colDesc.statusFieldDefinitions) {
    if (value === statusDef.value) {
      color = statusDef.color;
    }
  }
  const onclick = (event) => {
    const cell = event.target;
    const cellRect = cell.getBoundingClientRect();
    const menuItems = colDesc.menuItems.map((menuItem) => {
      return {
        ...menuItem,
        checked: menuItem.statusDef.value === item[colDesc.key],
        callback: () => {
          item[colDesc.key] = menuItem.statusDef.value;
          cell.style = cellColorStyle(menuItem.statusDef.color);
        },
      };
    });
    showMenu(menuItems, { x: cellRect.left, y: cellRect.bottom });
  };
  const props = {
    class: "status-cell",
    onclick: onclick,
  };
  if (color) {
    props["style"] = cellColorStyle(color);
    return html.div(props);
  } else {
    return html.div(props, [value]);
  }
}

function cellColorStyle(color) {
  return `background-color: ${rgbaToCSS(color)}; width: 100%;`;
}
