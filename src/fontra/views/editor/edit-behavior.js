import { polygonIsConvex } from "../core/convex-hull.js";
import { consolidateChanges } from "../core/changes.js";
import { makeAffineTransform, parseSelection, reversed } from "../core/utils.js";
import { Transform } from "../core/transform.js";
import * as vector from "../core/vector.js";
import {
  NIL,
  SEL,
  UNS,
  SHA,
  SMO,
  OFF,
  ANY,
  buildPointMatchTree,
  findPointMatch,
} from "./edit-behavior-support.js";

export class EditBehaviorFactory {
  constructor(instance, selection, enableScalingEdit = false) {
    const {
      point: pointSelection,
      component: componentSelection,
      componentOrigin: componentOriginSelection,
      componentTCenter: componentTCenterSelection,
    } = parseSelection(selection);
    const componentOriginIndices = unionIndexSets(
      componentSelection,
      componentOriginSelection
    );
    const relevantComponentIndices = unionIndexSets(
      componentSelection,
      componentOriginSelection,
      componentTCenterSelection
    );
    this.contours = unpackContours(instance.path, pointSelection || []);
    this.components = unpackComponents(instance.components, relevantComponentIndices);
    this.componentOriginIndices = componentOriginIndices || [];
    this.componentTCenterIndices = componentTCenterSelection || [];
    this.behaviors = {};
    this.enableScalingEdit = enableScalingEdit;
  }

  getBehavior(behaviorName) {
    let behavior = this.behaviors[behaviorName];
    if (!behavior) {
      let behaviorType = behaviorTypes[behaviorName];
      if (!behaviorType) {
        console.log(`invalid behavior name: "${behaviorName}"`);
        behaviorType = behaviorTypes["default"];
      }
      if (this.enableScalingEdit && behaviorType.canDoScalingEdit) {
        behaviorType = { ...behaviorType, enableScalingEdit: true };
      }
      behavior = new EditBehavior(
        this.contours,
        this.components,
        this.componentOriginIndices,
        this.componentTCenterIndices,
        behaviorType
      );
      this.behaviors[behaviorName] = behavior;
    }
    return behavior;
  }
}

class EditBehavior {
  constructor(
    contours,
    components,
    componentOriginIndices,
    componentTCenterIndices,
    behavior
  ) {
    this.roundFunc = Math.round;
    this.constrainDelta = behavior.constrainDelta || ((v) => v);
    const [pointEditFuncs, participatingPointIndices] = makePointEditFuncs(
      contours,
      behavior
    );
    this.pointEditFuncs = pointEditFuncs;

    const componentRollbackChanges = [];
    this.componentEditFuncs = [];

    for (const componentIndex of componentOriginIndices) {
      const [editFunc, compoRollback] = makeComponentOriginEditFunc(
        components[componentIndex],
        componentIndex,
        this.roundFunc
      );
      this.componentEditFuncs.push(editFunc);
      componentRollbackChanges.push(compoRollback);
    }

    for (const componentIndex of componentTCenterIndices) {
      const [editFunc, compoRollback] = makeComponentTCenterEditFunc(
        components[componentIndex],
        componentIndex,
        this.roundFunc
      );
      this.componentEditFuncs.push(editFunc);
      componentRollbackChanges.push(compoRollback);
    }

    this.rollbackChange = makeRollbackChange(
      contours,
      participatingPointIndices,
      componentRollbackChanges
    );
  }

  makeChangeForDelta(delta) {
    // For shift-constrain, we need two transform functions:
    // - one with the delta constrained to 0/45/90 degrees
    // - one with the 'free' delta
    // This is because shift-constrain does two fairly distinct things"
    // 1. Move points in only H or V directions
    // 2. Constrain Bézier handles to 0/45/90 degree angles
    // For the latter, we don't want the initial change (before the constraint)
    // to be constrained, but pin the handle angle based on the freely transformed
    // off-curve point.
    return this.makeChangeForTransformFunc(
      makePointTranslateFunction(this.constrainDelta(delta)),
      makePointTranslateFunction(delta)
    );
  }

  makeChangeForTransformFunc(transformFunc, freeTransformFunc) {
    const transform = {
      constrained: transformFunc,
      free: freeTransformFunc || transformFunc,
      constrainDelta: this.constrainDelta,
    };
    const pathChanges = this.pointEditFuncs
      ?.map((editFunc) => {
        const result = editFunc(transform);
        if (result) {
          const [pointIndex, x, y] = result;
          return makePointChange(pointIndex, this.roundFunc(x), this.roundFunc(y));
        }
      })
      .filter((change) => change);
    const componentChanges = this.componentEditFuncs?.map((editFunc) => {
      return editFunc(transform);
    });
    const changes = [];
    if (pathChanges && pathChanges.length) {
      changes.push(consolidateChanges(pathChanges, ["path"]));
    }
    if (componentChanges && componentChanges.length) {
      changes.push(consolidateChanges(componentChanges, ["components"]));
    }
    return consolidateChanges(changes);
  }
}

function unionIndexSets(...indexSets) {
  indexSets = indexSets.filter((item) => !!item);
  return [...new Set(indexSets.flat())].sort((a, b) => a - b);
}

function makeRollbackChange(contours, participatingPointIndices, componentRollback) {
  const pointRollback = [];
  for (let i = 0; i < contours.length; i++) {
    const contour = contours[i];
    const contourPointIndices = participatingPointIndices[i];
    if (!contour) {
      continue;
    }
    const point = contour.points;
    pointRollback.push(
      ...contourPointIndices.map((pointIndex) => {
        const point = contour.points[pointIndex];
        return makePointChange(pointIndex + contour.startIndex, point.x, point.y);
      })
    );
  }

  const changes = [];
  if (pointRollback.length) {
    changes.push(consolidateChanges(pointRollback, ["path"]));
  }
  if (componentRollback.length) {
    changes.push(consolidateChanges(componentRollback, ["components"]));
  }
  return consolidateChanges(changes);
}

function makeComponentOriginEditFunc(component, componentIndex, roundFunc) {
  const origin = {
    x: component.transformation.translateX,
    y: component.transformation.translateY,
  };
  return [
    (transform) => {
      const editedOrigin = transform.constrained(origin);
      return makeComponentOriginChange(
        componentIndex,
        roundFunc(editedOrigin.x),
        roundFunc(editedOrigin.y)
      );
    },
    makeComponentOriginChange(componentIndex, origin.x, origin.y),
  ];
}

function makeComponentTCenterEditFunc(component, componentIndex, roundFunc) {
  const transformation = { ...component.transformation };
  const origin = {
    x: transformation.translateX,
    y: transformation.translateY,
  };
  const tCenter = {
    x: transformation.tCenterX,
    y: transformation.tCenterY,
  };
  const affine = makeAffineTransform(transformation);
  const affineInv = affine.inverse();
  const localTCenter = affine.transformPointObject(tCenter);
  return [
    (transform) => {
      const editedTCenter = affineInv.transformPointObject(
        transform.constrained(localTCenter)
      );
      editedTCenter.x = roundFunc(editedTCenter.x);
      editedTCenter.y = roundFunc(editedTCenter.y);
      const editedAffine = makeAffineTransform({
        ...transformation,
        tCenterX: editedTCenter.x,
        tCenterY: editedTCenter.y,
      });
      const editedOrigin = {
        x: origin.x + affine.dx - editedAffine.dx,
        y: origin.y + affine.dy - editedAffine.dy,
      };
      return makeComponentTCenterChange(
        componentIndex,
        editedOrigin.x,
        editedOrigin.y,
        editedTCenter.x,
        editedTCenter.y
      );
    },
    makeComponentTCenterChange(
      componentIndex,
      origin.x,
      origin.y,
      tCenter.x,
      tCenter.y
    ),
  ];
}

function makePointTranslateFunction(delta) {
  return (point) => {
    return { x: point.x + delta.x, y: point.y + delta.y };
  };
}

function makePointChange(pointIndex, x, y) {
  return { f: "=xy", a: [pointIndex, x, y] };
}

function makeComponentOriginChange(componentIndex, x, y) {
  return {
    p: [componentIndex, "transformation"],
    c: [
      { f: "=", a: ["translateX", x] },
      { f: "=", a: ["translateY", y] },
    ],
  };
}

function makeComponentTCenterChange(componentIndex, x, y, cx, cy) {
  return {
    p: [componentIndex, "transformation"],
    c: [
      { f: "=", a: ["translateX", x] },
      { f: "=", a: ["translateY", y] },
      { f: "=", a: ["tCenterX", cx] },
      { f: "=", a: ["tCenterY", cy] },
    ],
  };
}

function unpackContours(path, selectedPointIndices) {
  // Return an array with one item per contour. An item is either `undefined`,
  // when no points from this contour are selected, or an object with contour info,
  const contours = new Array(path.contourInfo.length);
  let contourIndex = 0;
  for (const pointIndex of selectedPointIndices) {
    while (path.contourInfo[contourIndex].endPoint < pointIndex) {
      contourIndex++;
    }
    const contourStartIndex = !contourIndex
      ? 0
      : path.contourInfo[contourIndex - 1].endPoint + 1;
    let contour = contours[contourIndex];
    if (contour === undefined) {
      const contourEndIndex = path.contourInfo[contourIndex].endPoint + 1;
      const contourNumPoints = contourEndIndex - contourStartIndex;
      const contourPoints = new Array(contourNumPoints);
      contour = {
        startIndex: contourStartIndex,
        points: contourPoints,
        isClosed: path.contourInfo[contourIndex].isClosed,
      };
      for (let i = 0; i < contourNumPoints; i++) {
        contourPoints[i] = path.getPoint(i + contourStartIndex);
      }
      contours[contourIndex] = contour;
    }
    contour.points[pointIndex - contourStartIndex].selected = true;
  }
  return contours;
}

function unpackComponents(components, selectedComponentIndices) {
  const unpackedComponents = new Array(components.length);
  for (const componentIndex of selectedComponentIndices) {
    unpackedComponents[componentIndex] = {
      transformation: components[componentIndex].transformation,
    };
  }
  return unpackedComponents;
}

function makePointEditFuncs(contours, behavior) {
  const pointEditFuncs = [];
  const participatingPointIndices = new Array(contours.length);
  for (let contourIndex = 0; contourIndex < contours.length; contourIndex++) {
    const contour = contours[contourIndex];
    if (!contour) {
      continue;
    }
    const [editFuncs, pointIndices] = makeContourPointEditFuncs(contour, behavior);
    pointEditFuncs.push(...editFuncs);
    participatingPointIndices[contourIndex] = pointIndices;
  }
  return [pointEditFuncs, participatingPointIndices];
}

function makeContourPointEditFuncs(contour, behavior) {
  const startIndex = contour.startIndex;
  const originalPoints = contour.points;
  const editPoints = Array.from(originalPoints); // will be modified
  const additionalEditPoints = Array.from(originalPoints); // will be modified
  const numPoints = originalPoints.length;
  let participatingPointIndices = [];
  const editFuncsTransform = [];
  const editFuncsConstrain = [];

  // console.log("------");
  for (let i = 0; i < numPoints; i++) {
    const [match, neighborIndices] = findPointMatch(
      behavior.matchTree,
      i,
      originalPoints,
      numPoints,
      contour.isClosed
    );
    if (match === undefined) {
      continue;
    }
    // console.log(i, match.action, match.ruleIndex);
    const [prevPrevPrev, prevPrev, prev, thePoint, next, nextNext, nextNextNext] =
      match.direction > 0 ? neighborIndices : reversed(neighborIndices);
    participatingPointIndices.push(thePoint);
    const actionFunctionFactory = behavior.actions[match.action];
    if (actionFunctionFactory === undefined) {
      console.log(`Undefined action function: ${match.action}`);
      continue;
    }
    const actionFunc = actionFunctionFactory(
      originalPoints[prevPrevPrev],
      originalPoints[prevPrev],
      originalPoints[prev],
      originalPoints[thePoint],
      originalPoints[next],
      originalPoints[nextNext]
    );
    if (!match.constrain) {
      // transform
      editFuncsTransform.push((transform) => {
        const point = actionFunc(
          transform,
          originalPoints[prevPrevPrev],
          originalPoints[prevPrev],
          originalPoints[prev],
          originalPoints[thePoint],
          originalPoints[next],
          originalPoints[nextNext]
        );
        editPoints[thePoint] = point;
        additionalEditPoints[thePoint] = point;
        return [thePoint + startIndex, point.x, point.y];
      });
    } else {
      // constrain
      editFuncsConstrain.push((transform) => {
        const point = actionFunc(
          transform,
          editPoints[prevPrevPrev],
          editPoints[prevPrev],
          editPoints[prev],
          editPoints[thePoint],
          editPoints[next],
          editPoints[nextNext]
        );
        additionalEditPoints[thePoint] = point;
        return [thePoint + startIndex, point.x, point.y];
      });
    }
  }

  let conditionFunc, segmentFunc;
  if (behavior.enableScalingEdit) {
    segmentFunc = makeSegmentScalingEditFuncs;
    conditionFunc = (segment, points) =>
      segment.length >= 4 &&
      (points[segment[0]].selected || points[segment.at(-1)].selected) &&
      segment.slice(1, -1).every((i) => !points[i].selected);
  } else {
    segmentFunc = makeSegmentFloatingOffCurveEditFuncs;
    conditionFunc = (segment, points) =>
      segment.length >= 5 &&
      points[segment[0]].selected &&
      points[segment.at(-1)].selected &&
      segment.slice(1, -1).every((i) => !points[i].selected);
  }

  const [additionalEditFuncs, additionalPointIndices] = makeAdditionalEditFuncs(
    contour,
    additionalEditPoints,
    conditionFunc,
    segmentFunc
  );
  if (additionalPointIndices.length) {
    participatingPointIndices = [
      ...new Set([...participatingPointIndices, ...additionalPointIndices]),
    ].sort((a, b) => a - b);
  }
  return [
    [...editFuncsTransform, ...editFuncsConstrain, ...additionalEditFuncs],
    participatingPointIndices,
  ];
}

function makeAdditionalEditFuncs(contour, editPoints, conditionFunc, segmentFunc) {
  const points = contour.points;
  const editFuncs = [];
  const participatingPointIndices = [];
  for (const segment of iterSegmentPointIndices(points, contour.isClosed)) {
    if (!conditionFunc(segment, points)) {
      continue;
    }
    const [segmentEditFunc, pointIndices] = segmentFunc(segment, contour, editPoints);
    editFuncs.push(...segmentEditFunc);
    participatingPointIndices.push(...pointIndices);
  }
  return [editFuncs, participatingPointIndices];
}

function makeSegmentFloatingOffCurveEditFuncs(segment, contour, editPoints) {
  const originalPoints = contour.points;
  const startIndex = contour.startIndex;
  const editFuncs = [];
  const pointIndices = [];

  for (const i of segment.slice(2, -2)) {
    pointIndices.push(i);
    editFuncs.push((transform) => {
      const point = transform.constrained(originalPoints[i]);
      return [i + startIndex, point.x, point.y];
    });
  }
  return [editFuncs, pointIndices];
}

function makeSegmentScalingEditFuncs(segment, contour, editPoints) {
  const originalPoints = contour.points;
  const startIndex = contour.startIndex;
  const editFuncs = [];
  const pointIndices = [];
  const A = makeSegmentTransform(originalPoints, segment, false);
  const Ainv = A?.inverse();

  if (A && Ainv) {
    let T;
    editFuncs.push((transform) => {
      const B = makeSegmentTransform(editPoints, segment, true);
      T = B?.transform(Ainv);
    });
    for (const i of segment.slice(1, -1)) {
      pointIndices.push(i);
      editFuncs.push((transform) => {
        let point;
        if (T) {
          point = T.transformPointObject(originalPoints[i]);
        } else {
          point = editPoints[i];
        }
        return [i + startIndex, point.x, point.y];
      });
    }
  }
  return [editFuncs, pointIndices];
}

function makeSegmentTransform(points, pointIndices, allowConcave) {
  const pt0 = points[pointIndices[0]];
  const pt1 = points[pointIndices[1]];
  const pt2 = points[pointIndices.at(-2)];
  const pt3 = points[pointIndices.at(-1)];
  if (!allowConcave && !polygonIsConvex([pt0, pt1, pt2, pt3])) {
    return;
  }
  const intersection = vector.intersect(pt0, pt1, pt2, pt3);
  if (!intersection) {
    return undefined;
  }
  const v1 = vector.subVectors(intersection, pt0);
  const v2 = vector.subVectors(pt3, intersection);
  return new Transform(v1.x, v1.y, v2.x, v2.y, pt0.x, pt0.y);
}

function* iterSegmentPointIndices(originalPoints, isClosed) {
  const lastPointIndex = originalPoints.length - 1;
  const firstOnCurve = findFirstOnCurvePoint(originalPoints, isClosed);
  if (firstOnCurve === undefined) {
    return;
  }
  let currentOnCurve = firstOnCurve;
  while (true) {
    const indices = [
      ...iterUntilNextOnCurvePoint(originalPoints, currentOnCurve, isClosed),
    ];
    if (!indices.length) {
      break;
    }
    yield indices;
    currentOnCurve = indices.at(-1);
    if (
      (isClosed && currentOnCurve == firstOnCurve) ||
      (!isClosed && currentOnCurve == lastPointIndex)
    ) {
      break;
    }
  }
}

function findFirstOnCurvePoint(points, isClosed) {
  const numPoints = points.length;
  for (let i = 0; i < numPoints; i++) {
    if (!points[i].type) {
      return i;
    }
  }
  return undefined;
}

function* iterUntilNextOnCurvePoint(points, startIndex, isClosed) {
  yield startIndex;
  const numPoints = points.length;
  for (let i = startIndex + 1; i < numPoints; i++) {
    yield i;
    if (!points[i].type) {
      return;
    }
  }
  if (!isClosed || !startIndex) {
    return;
  }
  for (let i = 0; i < startIndex; i++) {
    yield i;
    if (!points[i].type) {
      return;
    }
  }
}

export function constrainHorVerDiag(vector) {
  const constrainedVector = { ...vector };
  const ax = Math.abs(vector.x);
  const ay = Math.abs(vector.y);
  let tan;
  if (ax < 0.001) {
    tan = 0;
  } else {
    tan = ay / ax;
  }
  if (0.414 < tan && tan < 2.414) {
    // between 22.5 and 67.5 degrees
    const d = 0.5 * (ax + ay);
    constrainedVector.x = d * Math.sign(constrainedVector.x);
    constrainedVector.y = d * Math.sign(constrainedVector.y);
  } else if (ax > ay) {
    constrainedVector.y = 0;
  } else {
    constrainedVector.x = 0;
  }
  return constrainedVector;
}

const actionFactories = {
  DontMove: (prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
    return (transform, prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
      return thePoint;
    };
  },

  Move: (prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
    return (transform, prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
      return transform.constrained(thePoint);
    };
  },

  RotateNext: (prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
    const handle = vector.subVectors(thePoint, prev);
    const handleLength = Math.hypot(handle.x, handle.y);
    return (transform, prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
      const delta = vector.subVectors(prev, prevPrev);
      if (!delta.x && !delta.y) {
        // The angle is undefined, atan2 will return 0, let's just not touch the point
        return thePoint;
      }
      const angle = Math.atan2(delta.y, delta.x);
      const handlePoint = {
        x: prev.x + handleLength * Math.cos(angle),
        y: prev.y + handleLength * Math.sin(angle),
      };
      return handlePoint;
    };
  },

  ConstrainPrevAngle: (prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
    const pt1 = prevPrev;
    const pt2 = prev;
    const perpVector = vector.rotateVector90CW(vector.subVectors(pt2, pt1));
    return (transform, prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
      let point = transform.free(thePoint);
      const intersection = vector.intersect(
        pt1,
        pt2,
        point,
        vector.addVectors(point, perpVector)
      );
      if (!intersection) {
        return point;
      }
      return intersection;
    };
  },

  ConstrainMiddle: (prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
    const pt1 = prev;
    const pt2 = next;
    const perpVector = vector.rotateVector90CW(vector.subVectors(pt2, pt1));
    return (transform, prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
      let point = transform.free(thePoint);
      const intersection = vector.intersect(
        pt1,
        pt2,
        point,
        vector.addVectors(point, perpVector)
      );
      if (!intersection) {
        return point;
      }
      return intersection;
    };
  },

  ConstrainMiddleTwo: (prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
    const pt1 = prevPrev;
    const pt2 = next;
    const perpVector = vector.rotateVector90CW(vector.subVectors(pt2, pt1));
    return (transform, prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
      let point = transform.free(thePoint);
      const intersection = vector.intersect(
        pt1,
        pt2,
        point,
        vector.addVectors(point, perpVector)
      );
      if (!intersection) {
        return point;
      }
      return intersection;
    };
  },

  TangentIntersect: (prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
    const nextHandle = vector.subVectors(thePoint, next);
    return (transform, prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
      let point = transform.free(thePoint);
      const intersection = vector.intersect(
        prevPrev,
        prev,
        next,
        vector.addVectors(next, nextHandle)
      );
      if (!intersection) {
        return point;
      }
      return intersection;
    };
  },

  TangentIntersectLive: (prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
    return (transform, prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
      let point = transform.free(thePoint);
      const intersection = vector.intersect(prevPrev, prev, next, nextNext);
      if (!intersection) {
        return thePoint;
      }
      return intersection;
    };
  },

  HandleIntersect: (prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
    const handlePrev = vector.subVectors(thePoint, prev);
    const handleNext = vector.subVectors(thePoint, next);
    return (transform, prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
      const intersection = vector.intersect(
        prev,
        vector.addVectors(prev, handlePrev),
        next,
        vector.addVectors(next, handleNext)
      );
      if (!intersection) {
        return thePoint;
      }
      return intersection;
    };
  },

  ConstrainHandle: (prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
    return (transform, prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
      const newPoint = transform.free(thePoint);
      const handleVector = transform.constrainDelta(vector.subVectors(newPoint, prev));
      return vector.addVectors(prev, handleVector);
    };
  },

  ConstrainHandleIntersect: (
    prevPrevPrev,
    prevPrev,
    prev,
    thePoint,
    next,
    nextNext
  ) => {
    return (transform, prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
      const newPoint = transform.free(thePoint);
      const handlePrev = transform.constrainDelta(vector.subVectors(newPoint, prev));
      const handleNext = transform.constrainDelta(vector.subVectors(newPoint, next));

      const intersection = vector.intersect(
        prev,
        vector.addVectors(prev, handlePrev),
        next,
        vector.addVectors(next, handleNext)
      );
      if (!intersection) {
        return newPoint;
      }
      return intersection;
    };
  },

  ConstrainHandleIntersectPrev: (
    prevPrevPrev,
    prevPrev,
    prev,
    thePoint,
    next,
    nextNext
  ) => {
    const tangentPrev = vector.subVectors(prev, prevPrev);
    return (transform, prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
      const newPoint = transform.free(thePoint);
      const handleNext = transform.constrainDelta(vector.subVectors(newPoint, next));

      const intersection = vector.intersect(
        prev,
        vector.addVectors(prev, tangentPrev),
        next,
        vector.addVectors(next, handleNext)
      );
      if (!intersection) {
        return newPoint;
      }
      return intersection;
    };
  },

  Interpolate: (prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
    const lenPrevNext = vector.distance(next, prev);
    const lenPrev = vector.distance(thePoint, prev);
    let t = lenPrevNext > 0.0001 ? lenPrev / lenPrevNext : 0;
    return (transform, prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
      const prevNext = vector.subVectors(next, prev);
      return vector.addVectors(prev, vector.mulVector(prevNext, t));
    };
  },

  InterpolatePrevPrevNext: (prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
    const lenPrevPrevNext = vector.distance(next, prevPrev);
    const lenPrevPrev = vector.distance(thePoint, prevPrev);
    let t = lenPrevPrevNext > 0.0001 ? lenPrevPrev / lenPrevPrevNext : 0;
    return (transform, prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
      const prevPrevNext = vector.subVectors(next, prevPrev);
      return vector.addVectors(prevPrev, vector.mulVector(prevPrevNext, t));
    };
  },

  ConstrainAroundPrevPrev: (prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
    return (transform, prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
      const newPoint = transform.free(thePoint);
      const handleVector = transform.constrainDelta(
        vector.subVectors(newPoint, prevPrev)
      );
      return vector.addVectors(prevPrev, handleVector);
    };
  },

  ConstrainAroundPrevPrevPrev: (
    prevPrevPrev,
    prevPrev,
    prev,
    thePoint,
    next,
    nextNext
  ) => {
    return (transform, prevPrevPrev, prevPrev, prev, thePoint, next, nextNext) => {
      const newPoint = transform.free(thePoint);
      const handleVector = transform.constrainDelta(
        vector.subVectors(newPoint, prevPrevPrev)
      );
      return vector.addVectors(prevPrevPrev, handleVector);
    };
  },
};

// prettier-ignore
const defaultRules = [
  //   prev3       prevPrev    prev        the point   next        nextNext    Constrain   Action

  // Default rule: if no other rules apply, just move the selected point
  [    ANY|NIL,    ANY|NIL,    ANY|NIL,    ANY|SEL,    ANY|NIL,    ANY|NIL,    false,      "Move"],

  // Unselected off-curve point next to a smooth point next to a selected point
  [    ANY|NIL,    ANY|SEL,    SMO|UNS,    OFF|UNS,    OFF|SHA|NIL,ANY|NIL,    true,       "RotateNext"],

  // Selected tangent point: its neighboring off-curve point should move
  [    ANY|NIL,    SHA|SMO|UNS,SMO|SEL,    OFF|UNS,    OFF|SHA|NIL,ANY|NIL,    true,       "RotateNext"],

  // Selected tangent point, selected handle: constrain both on original angle
  [    ANY|NIL,    SHA|SMO|UNS,SMO|SEL,    OFF|SEL,    OFF|SHA|NIL,ANY|NIL,    true,       "ConstrainPrevAngle"],
  [    ANY|NIL,    ANY,        SHA|SMO|UNS,SMO|SEL,    OFF|SEL,    OFF|SHA|NIL,true,       "ConstrainMiddle"],

  // Unselected free off-curve point, move with on-curve neighbor
  [    ANY|NIL,    ANY|NIL,    SHA|SMO|SEL,OFF|UNS,    OFF|SHA|NIL,ANY|NIL,    false,      "Move"],
  [    ANY|NIL,    OFF,        SMO|SEL,    OFF|UNS,    OFF|SHA|NIL,ANY|NIL,    false,      "Move"],

  // An unselected off-curve between two on-curve points
  [    ANY|NIL,    ANY,        SMO|SHA|SEL,OFF|UNS,    SMO|SHA,    ANY|NIL,    true,       "HandleIntersect"],
  [    ANY|NIL,    ANY|SEL,    SMO|UNS,    OFF|UNS,    SMO,        ANY|NIL,    true,       "TangentIntersectLive"],
  [    ANY|NIL,    SMO|SHA,    SMO|SEL,    OFF|UNS,    SMO|SHA,    ANY|NIL,    true,       "TangentIntersect"],
  [    ANY|NIL,    SMO|SHA,    SMO|UNS,    OFF|SEL,    SMO|SEL,    ANY|NIL,    true,       "HandleIntersect"],
  [    ANY|NIL,    ANY|SEL,    SMO|UNS,    OFF|UNS,    SHA|SEL,    ANY|NIL,    true,       "TangentIntersect"],

  // Tangent bcp constraint
  [    ANY|NIL,    SMO|SHA,    SMO|UNS,    OFF|SEL,    ANY|UNS|NIL,ANY|NIL,    false,      "ConstrainPrevAngle"],
  [    ANY|NIL,    SMO|SHA,    SMO|UNS,    OFF|SEL,    SHA|OFF,    ANY|NIL,    false,      "ConstrainPrevAngle"],

  // Two selected points with an unselected smooth point between them
  [    ANY|NIL,    ANY|SEL,    SMO|UNS,    ANY|SEL,    ANY|NIL,    ANY|NIL,    false,      "ConstrainPrevAngle"],
  [    ANY|NIL,    ANY|SEL,    SMO|UNS,    ANY|SEL,    SMO|UNS,    ANY|SEL,    false,      "DontMove"],
  [    ANY|NIL,    ANY|SEL,    SMO|UNS,    ANY|SEL,    SMO|UNS,    SMO|UNS,    false,      "DontMove"],

  // Selected tangent with selected handle: constrain at original tangent line
  [    ANY|NIL,    SMO|SHA|UNS,SMO|SEL,    OFF|SEL,    ANY|NIL,    ANY|NIL,    false,      "ConstrainPrevAngle"],
  [    ANY|NIL,    ANY,        SHA|SMO|UNS,SMO|SEL,    OFF|SEL,    ANY|NIL,    true,       "ConstrainMiddle"],

  // Selected tangent, selected off-curve, selected smooth
  [    ANY|NIL,    SMO|SHA|UNS,SMO|SEL,    OFF|SEL,    SMO|SEL,    ANY|NIL,    true,       "HandleIntersect"],

  // Selected single off-curve, locked between two unselected smooth points
  [    ANY|NIL,    SHA|SMO|UNS,SMO|UNS,    OFF|SEL,    SMO|UNS,    OFF|SEL,    false,      "DontMove"],

];

// prettier-ignore
const constrainRules = defaultRules.concat([

  // Selected free off curve: constrain to 0, 45 or 90 degrees
  [    ANY|NIL,    OFF|UNS,    SMO|UNS,    OFF|SEL,    OFF|NIL,    ANY|NIL,    false,      "ConstrainHandle"],
  [    ANY|NIL,    ANY|NIL,    SHA|UNS,    OFF|SEL,    OFF|NIL,    ANY|NIL,    false,      "ConstrainHandle"],
  [    ANY|NIL,    OFF|UNS,    SMO|UNS,    OFF|SEL,    SMO|UNS,    OFF|UNS,    false,      "ConstrainHandleIntersect"],
  [    ANY|NIL,    ANY|NIL,    SHA|UNS,    OFF|SEL,    SHA|UNS,    ANY|NIL,    false,      "ConstrainHandleIntersect"],
  [    ANY|NIL,    OFF|UNS,    SMO|UNS,    OFF|SEL,    SHA|UNS,    ANY|NIL,    false,      "ConstrainHandleIntersect"],
  [    ANY|NIL,    SHA|SMO|UNS,SMO|UNS,    OFF|SEL,    SMO|UNS,    OFF|UNS,    false,      "ConstrainHandleIntersectPrev"],

  // Selected smooth between unselected on-curve and off-curve
  [    ANY|NIL,    ANY|UNS,    SMO|SHA|UNS,SMO|SEL,    OFF|UNS,    ANY|NIL,    false,      "ConstrainHandle"],

]);

// prettier-ignore
const alternateRules = [
  //   prev3       prevPrev    prev        the point   next        nextNext    Constrain   Action

  // Default rule: if no other rules apply, just move the selected point
  [    ANY|NIL,    ANY|NIL,    ANY|NIL,    ANY|SEL,    ANY|NIL,    ANY|NIL,    false,      "Move"],

  // Selected smooth before unselected off-curve
  [    ANY|NIL,    ANY|NIL,    ANY|UNS,    SMO|SEL,    OFF,        ANY|NIL,    false,      "ConstrainMiddle"],
  [    ANY|NIL,    OFF,        SMO|SEL,    SMO|SEL,    OFF|UNS,    ANY|NIL,    false,      "ConstrainMiddleTwo"],
  [    ANY|NIL,    OFF|UNS,    SMO|SEL,    SMO|SEL,    OFF|SEL,    ANY|NIL,    false,      "ConstrainMiddleTwo"],
  [    ANY|NIL,    SMO|SEL,    SMO|SEL,    OFF|SEL,    ANY|NIL,    ANY|NIL,    true,       "RotateNext"],
  [    ANY|NIL,    SMO|SEL,    SMO|UNS,    OFF|SEL,    ANY|NIL,    ANY|NIL,    true,       "ConstrainPrevAngle"],
  [    ANY|NIL,    SMO|UNS,    SMO|SEL,    OFF|SEL,    ANY|NIL,    ANY|NIL,    true,       "ConstrainPrevAngle"],

  // Smooth with two selected neighbors
  [    ANY|NIL,    ANY|NIL,    ANY|SEL,    SMO|SEL,    OFF|SEL,    ANY|NIL,    false,      "ConstrainMiddle"],

  // Unselected smooth between sharp and off-curve, one of them selected
  [    ANY|NIL,    ANY|NIL,    SHA|OFF|UNS,SMO|UNS,    OFF|SEL,    ANY|NIL,    true,       "Interpolate"],
  [    ANY|NIL,    ANY|NIL,    SHA|OFF|SEL,SMO|UNS,    OFF|UNS,    ANY|NIL,    true,       "Interpolate"],

  // Two unselected smooth points between two off-curves, one of them selected
  [    ANY|NIL,    OFF|UNS,    SMO|UNS,    SMO|UNS,    OFF|SEL,    ANY|NIL,    true,       "InterpolatePrevPrevNext"],
  [    ANY|NIL,    OFF|SEL,    SMO|UNS,    SMO|UNS,    OFF|UNS,    ANY|NIL,    true,       "InterpolatePrevPrevNext"],

  // An unselected smooth point between two selected off-curves
  [    ANY|NIL,    ANY|NIL,    OFF|SEL,    SMO|UNS,    OFF|SEL,    ANY|NIL,    true,       "Move"],

  // Two unselected smooth points between two selected off-curves
  [    ANY|NIL,    OFF|SEL,    SMO|UNS,    SMO|UNS,    OFF|SEL,    ANY|NIL,    true,       "Move"],

  // Two selected points locked by angle
  [    ANY|NIL,    ANY,        SHA|SEL,    SMO|SEL,    OFF|UNS,    OFF|SHA|NIL,false,      "ConstrainMiddle"],
  [    ANY|NIL,    ANY,        SMO|SEL,    SHA|SEL,    ANY|NIL,    ANY|NIL,    false,      "ConstrainPrevAngle"],
  [    ANY|NIL,    ANY,        SMO|SEL,    OFF|SEL,    ANY|NIL,    ANY|NIL,    false,      "ConstrainPrevAngle"],

  // Selected off-curve locked between two selected smooth points
  [    ANY|NIL,    ANY|NIL,    SMO|SEL,    OFF|SEL,    SMO|SEL,    ANY|NIL,    false,      "DontMove"],

]

// prettier-ignore
const alternateConstrainRules = alternateRules.concat([

  [    ANY|NIL,    SHA|OFF|UNS,SMO|UNS,    SHA|OFF|SEL,ANY|NIL,    ANY|NIL,    false,      "ConstrainAroundPrevPrev"],

  // Two unselected smooth points between two off-curves, one of them selected
  [    ANY|UNS,    SMO|UNS,    SMO|UNS,    OFF|SEL,    ANY|NIL,    ANY|NIL,    false,      "ConstrainAroundPrevPrevPrev"],

]);

const behaviorTypes = {
  "default": {
    matchTree: buildPointMatchTree(defaultRules),
    actions: actionFactories,
    canDoScalingEdit: true,
  },

  "constrain": {
    matchTree: buildPointMatchTree(constrainRules),
    actions: actionFactories,
    constrainDelta: constrainHorVerDiag,
    canDoScalingEdit: true,
  },

  "alternate": {
    matchTree: buildPointMatchTree(alternateRules),
    actions: actionFactories,
  },

  "alternate-constrain": {
    matchTree: buildPointMatchTree(alternateConstrainRules),
    actions: actionFactories,
    constrainDelta: constrainHorVerDiag,
  },
};
