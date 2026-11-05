export const LOCAL_CARD_IMAGE_PATH = "__acp_local_image_path";
export const LOCAL_CARD_MARKDOWN_IMAGES = "__acp_local_markdown_images";

export function localCardMarkdown(content: string): Record<string, unknown> {
  return { tag: "markdown", content, [LOCAL_CARD_MARKDOWN_IMAGES]: true };
}

export function localCardImage(filePath: string, label: string): Record<string, unknown> {
  return {
    tag: "img",
    img_key: "",
    [LOCAL_CARD_IMAGE_PATH]: filePath,
    alt: { tag: "plain_text", content: label },
    title: { tag: "plain_text", content: label },
    mode: "fit_horizontal",
    preview: true,
  };
}
