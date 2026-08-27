export const GRAPHICS_SIZES = Object.freeze([
  { id: "square", label: "Square post", width: 1080, height: 1080 },
  { id: "portrait", label: "Portrait post", width: 1080, height: 1350 },
  { id: "story", label: "Story", width: 1080, height: 1920 },
  { id: "landscape", label: "Landscape", width: 1920, height: 1080 },
]);

export const GRAPHICS_BRAND_COLORS = Object.freeze([
  "#08080a",
  "#be123c",
  "#e11d48",
  "#f4bd50",
  "#fff7e6",
  "#ffffff",
]);

function graphicsId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `graphic-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const DEFAULTS_BY_TYPE = {
  text: {
    name: "Text",
    x: 90,
    y: 120,
    width: 820,
    height: 160,
    content: "Your headline",
    color: "#ffffff",
    fontSize: 92,
    fontWeight: 800,
    lineHeight: 1,
    textAlign: "left",
  },
  rectangle: {
    name: "Rectangle",
    x: 180,
    y: 260,
    width: 420,
    height: 260,
    color: "#be123c",
    cornerRadius: 24,
  },
  circle: {
    name: "Circle",
    x: 270,
    y: 270,
    width: 320,
    height: 320,
    color: "#f4bd50",
  },
  image: {
    name: "Image",
    x: 120,
    y: 180,
    width: 840,
    height: 600,
    src: "",
  },
};

export function createGraphicsObject(type, index = 0, source = {}) {
  if (!Object.hasOwn(DEFAULTS_BY_TYPE, type)) {
    throw new Error("Graphics objects must be text, rectangle, circle, or image.");
  }

  return {
    id: graphicsId(),
    type,
    opacity: 1,
    ...DEFAULTS_BY_TYPE[type],
    name: `${DEFAULTS_BY_TYPE[type].name} ${index + 1}`,
    ...source,
  };
}

export function createGraphicsDocument(source = {}) {
  return {
    title: "Untitled graphic",
    sizeId: "square",
    background: "#08080a",
    objects: [
      createGraphicsObject("rectangle", 0, {
        id: "starter-crimson",
        name: "Crimson panel",
        x: 0,
        y: 0,
        width: 390,
        height: 1080,
        color: "#be123c",
        cornerRadius: 0,
      }),
      createGraphicsObject("circle", 0, {
        id: "starter-gold",
        name: "Gold accent",
        x: 820,
        y: 70,
        width: 190,
        height: 190,
        color: "#f4bd50",
        opacity: 0.94,
      }),
      createGraphicsObject("text", 0, {
        id: "starter-heading",
        name: "Main headline",
        x: 90,
        y: 190,
        width: 860,
        height: 270,
        content: "CREATE\nBOLDLY",
        color: "#ffffff",
        fontSize: 116,
        fontWeight: 900,
        lineHeight: 0.9,
      }),
      createGraphicsObject("text", 1, {
        id: "starter-subheading",
        name: "Subheading",
        x: 440,
        y: 570,
        width: 520,
        height: 120,
        content: "STATIC GRAPHICS\nBUILT IN G.FURY",
        color: "#f4bd50",
        fontSize: 38,
        fontWeight: 800,
        lineHeight: 1.25,
      }),
      createGraphicsObject("rectangle", 1, {
        id: "starter-rule",
        name: "Gold rule",
        x: 440,
        y: 760,
        width: 340,
        height: 14,
        color: "#f4bd50",
        cornerRadius: 7,
      }),
    ],
    ...source,
  };
}

export function getGraphicsSize(sizeId) {
  return GRAPHICS_SIZES.find((size) => size.id === sizeId) || GRAPHICS_SIZES[0];
}

export function addGraphicsObject(document, type, source = {}) {
  const object = createGraphicsObject(type, document.objects.length, source);
  return {
    document: { ...document, objects: [...document.objects, object] },
    selectedObjectId: object.id,
  };
}

export function updateGraphicsObject(document, objectId, patch) {
  return {
    ...document,
    objects: document.objects.map((object) => (
      object.id === objectId ? { ...object, ...patch, id: object.id, type: object.type } : object
    )),
  };
}

export function duplicateGraphicsObject(document, objectId, source = {}) {
  const sourceIndex = document.objects.findIndex((object) => object.id === objectId);
  if (sourceIndex < 0) return { document, selectedObjectId: objectId };

  const original = document.objects[sourceIndex];
  const duplicate = createGraphicsObject(original.type, document.objects.length, {
    ...original,
    id: source.id || graphicsId(),
    name: `${original.name} copy`,
    x: original.x + 24,
    y: original.y + 24,
  });
  const objects = [...document.objects];
  objects.splice(sourceIndex + 1, 0, duplicate);
  return {
    document: { ...document, objects },
    selectedObjectId: duplicate.id,
  };
}

export function deleteGraphicsObject(document, objectId) {
  return {
    document: {
      ...document,
      objects: document.objects.filter((object) => object.id !== objectId),
    },
    selectedObjectId: null,
  };
}

export function reorderGraphicsObject(document, objectId, direction) {
  const sourceIndex = document.objects.findIndex((object) => object.id === objectId);
  if (sourceIndex < 0) return document;
  const offset = direction === "forward" ? 1 : direction === "backward" ? -1 : 0;
  const destinationIndex = Math.max(0, Math.min(document.objects.length - 1, sourceIndex + offset));
  if (destinationIndex === sourceIndex) return document;

  const objects = [...document.objects];
  const [object] = objects.splice(sourceIndex, 1);
  objects.splice(destinationIndex, 0, object);
  return { ...document, objects };
}

export function resizeGraphicsDocument(document, sizeId) {
  const currentSize = getGraphicsSize(document.sizeId);
  const nextSize = getGraphicsSize(sizeId);
  if (currentSize.id === nextSize.id) return document;

  const scaleX = nextSize.width / currentSize.width;
  const scaleY = nextSize.height / currentSize.height;
  const fontScale = Math.min(scaleX, scaleY);
  return {
    ...document,
    sizeId: nextSize.id,
    objects: document.objects.map((object) => ({
      ...object,
      x: Math.round(object.x * scaleX),
      y: Math.round(object.y * scaleY),
      width: Math.round(object.width * scaleX),
      height: Math.round(object.height * scaleY),
      ...(object.type === "text" ? { fontSize: Math.max(12, Math.round(object.fontSize * fontScale)) } : {}),
    })),
  };
}
