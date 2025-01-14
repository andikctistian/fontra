import { recordChanges } from "/core/change-recorder.js";
import { Form } from "/core/ui-form.js";
import {
  getCharFromUnicode,
  makeUPlusStringFromCodePoint,
  parseSelection,
} from "/core/utils.js";

export class SidebarSelectionInfo {
  constructor(sceneController, fontController) {
    this.sceneController = sceneController;
    this.fontController = fontController;
    this.infoForm = new Form("selection-info");
  }

  async update() {
    if (!this.infoForm.container.offsetParent) {
      // If the info form is not visible, do nothing
      return;
    }
    const varGlyphController =
      await this.sceneController.sceneModel.getSelectedVariableGlyphController();
    const positionedGlyph =
      this.sceneController.sceneModel.getSelectedPositionedGlyph();
    const glyphController = positionedGlyph?.glyph;
    const instance = glyphController?.instance;
    const glyphName = glyphController?.name;
    let unicodes = this.fontController.glyphMap?.[glyphName] || [];
    if (positionedGlyph?.isUndefined && positionedGlyph.character && !unicodes.length) {
      // Glyph does not yet exist in the font, so varGlyphController is undefined,
      // But we can grab the unicode from positionedGlyph.character anyway.
      unicodes = [positionedGlyph.character.codePointAt(0)];
    }
    const unicodesStr = unicodes
      .map(
        (code) =>
          `${makeUPlusStringFromCodePoint(code)}\u00A0(${getCharFromUnicode(code)})`
      )
      .join(" ");
    const canEdit = glyphController?.canEdit;

    const formContents = [];
    if (glyphName) {
      formContents.push({
        key: "glyphName",
        type: "text",
        label: "Glyph name",
        value: glyphName,
      });
      formContents.push({
        key: "unicodes",
        type: "text",
        label: "Unicode",
        value: unicodesStr,
      });
      formContents.push({
        type: "edit-number",
        key: '["xAdvance"]',
        label: "Advance width",
        value: instance.xAdvance,
        disabled: !canEdit,
      });
    }
    const { component, componentOrigin, componentTCenter } = parseSelection(
      this.sceneController.selection
    );
    const componentIndices = [
      ...new Set([
        ...(component || []),
        ...(componentOrigin || []),
        ...(componentTCenter || []),
      ]),
    ].sort((a, b) => a - b);

    for (const index of componentIndices || []) {
      const component = instance.components[index];
      if (!component) {
        // Invalid selection
        continue;
      }
      const componentKey = (...path) => JSON.stringify(["components", index, ...path]);

      formContents.push({ type: "divider" });
      formContents.push({ type: "header", label: `Component #${index}` });
      formContents.push({
        type: "edit-text",
        key: componentKey("name"),
        label: "Base glyph",
        value: component.name,
      });
      formContents.push({ type: "header", label: "Transformation" });

      for (const key of [
        "translateX",
        "translateY",
        "rotation",
        "scaleX",
        "scaleY",
        "skewX",
        "skewY",
        "tCenterX",
        "tCenterY",
      ]) {
        const value = component.transformation[key];
        formContents.push({
          type: "edit-number",
          key: componentKey("transformation", key),
          label: key,
          value: value,
          disabled: !canEdit,
        });
      }
      const baseGlyph = await this.fontController.getGlyph(component.name);
      if (baseGlyph && component.location) {
        const locationItems = [];
        const axes = Object.fromEntries(
          baseGlyph.axes.map((axis) => [axis.name, axis])
        );
        // Add global axes, if in location and not in baseGlyph.axes
        // TODO: this needs more thinking, as the axes of *nested* components
        // may also be of interest. Also: we need to be able to *add* such a value
        // to component.location.
        for (const axis of this.fontController.globalAxes) {
          if (axis.name in component.location && !(axis.name in axes)) {
            axes[axis.name] = axis;
          }
        }
        for (const axis of Object.values(axes)) {
          let value = component.location[axis.name];
          if (value === undefined) {
            value = axis.defaultValue;
          }
          locationItems.push({
            type: "edit-number-slider",
            key: componentKey("location", axis.name),
            label: axis.name,
            value: value,
            minValue: axis.minValue,
            maxValue: axis.maxValue,
            disabled: !canEdit,
          });
        }
        if (locationItems.length) {
          formContents.push({ type: "header", label: "Location" });
          formContents.push(...locationItems);
        }
      }
    }
    if (!formContents.length) {
      this.infoForm.setFieldDescriptions([{ type: "text", value: "(No selection)" }]);
    } else {
      this.infoForm.setFieldDescriptions(formContents);
      await this._setupSelectionInfoHandlers(glyphName);
    }
  }

  async _setupSelectionInfoHandlers(glyphName) {
    this.infoForm.onFieldChange = async (fieldKey, value, valueStream) => {
      const changePath = JSON.parse(fieldKey);
      await this.sceneController.editInstance(
        async (sendIncrementalChange, instance) => {
          let changes;

          if (valueStream) {
            // Continuous changes (eg. slider drag)
            const orgValue = getNestedValue(instance, changePath);
            for await (const value of valueStream) {
              if (orgValue !== undefined) {
                setNestedValue(instance, changePath, orgValue); // Ensure getting the correct undo change
              } else {
                deleteNestedValue(instance, changePath);
              }
              changes = recordChanges(instance, (instance) => {
                setNestedValue(instance, changePath, value);
              });
              await sendIncrementalChange(changes.change, true); // true: "may drop"
            }
          } else {
            // Simple, atomic change
            changes = recordChanges(instance, (instance) => {
              setNestedValue(instance, changePath, value);
            });
          }

          const plen = changePath.length;
          const undoLabel =
            plen == 1
              ? `${changePath[plen - 1]}`
              : `${changePath[plen - 2]}.${changePath[plen - 1]}`;
          return {
            changes: changes,
            undoLabel: undoLabel,
            broadcast: true,
          };
        },
        this
      );
    };
  }
}

function getNestedValue(subject, path) {
  for (const pathElement of path) {
    if (subject === undefined) {
      throw new Error(`assert -- invalid change path: ${path}`);
    }
    subject = subject[pathElement];
  }
  return subject;
}

function setNestedValue(subject, path, value) {
  const key = path.slice(-1)[0];
  path = path.slice(0, -1);
  subject = getNestedValue(subject, path);
  subject[key] = value;
}

function deleteNestedValue(subject, path) {
  const key = path.slice(-1)[0];
  path = path.slice(0, -1);
  subject = getNestedValue(subject, path);
  delete subject[key];
}
