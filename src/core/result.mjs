export function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: String(value)
      }
    ]
  };
}

export function jsonResult(value) {
  return textResult(JSON.stringify(value, null, 2));
}

export function imageResult(note, base64, mimeType = "image/png") {
  return {
    content: [
      {
        type: "text",
        text: String(note)
      },
      {
        type: "image",
        data: base64,
        mimeType
      }
    ]
  };
}
