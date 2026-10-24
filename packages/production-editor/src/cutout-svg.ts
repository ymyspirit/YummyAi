import { ProductionCutoutRecipeSchema, type ProductionCutoutRecipe } from "@yummyai/contracts/pod/production-cutout";

/** Only validated numeric paths and embedded PNG bytes enter this SVG. */
export function cutoutMaskSvg(input: ProductionCutoutRecipe, width: number, height: number) {
  const recipe = ProductionCutoutRecipeSchema.parse(input);
  const size = Math.min(width, height);
  const definitions: string[] = [];
  let body = recipe.maskPngBase64 ? `<image href="data:image/png;base64,${recipe.maskPngBase64}" width="${width}" height="${height}" preserveAspectRatio="none"/>` : `<rect width="${width}" height="${height}" fill="white"/>`;
  recipe.operations.forEach((operation, index) => {
    if (operation.kind === "clean-alpha") {
      const slope = 1 / (1 - operation.threshold), intercept = -operation.threshold * slope;
      definitions.push(`<filter id="clean${index}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feComponentTransfer>${["R", "G", "B"].map((channel) => `<feFunc${channel} type="linear" slope="${slope}" intercept="${intercept}"/>`).join("")}</feComponentTransfer></filter>`);
      body = `<g filter="url(#clean${index})">${body}</g>`;
      return;
    }
    const coordinates = operation.points.map((point) => `${point.x * width},${point.y * height}`).join(" ");
    if (operation.kind === "polygon" && operation.mode === "keep") {
      definitions.push(`<clipPath id="keep${index}"><polygon points="${coordinates}"/></clipPath>`);
      body = `<g clip-path="url(#keep${index})">${body}</g>`;
      return;
    }
    const color = operation.mode === "erase" ? "black" : "white";
    if (operation.kind === "polygon") body += `<polygon points="${coordinates}" fill="${color}"/>`;
    else {
      const radius = operation.radius * size;
      const blur = operation.softness * radius * 0.35;
      if (blur > 0) {
        const xs = operation.points.map((point) => point.x * width), ys = operation.points.map((point) => point.y * height);
        const margin = radius + blur * 4;
        definitions.push(`<filter id="soft${index}" filterUnits="userSpaceOnUse" x="${Math.min(...xs) - margin}" y="${Math.min(...ys) - margin}" width="${Math.max(...xs) - Math.min(...xs) + margin * 2}" height="${Math.max(...ys) - Math.min(...ys) + margin * 2}"><feGaussianBlur stdDeviation="${blur}"/></filter>`);
      }
      const filter = blur > 0 ? ` filter="url(#soft${index})"` : "";
      const point = operation.points[0]!;
      body += operation.points.every((value) => value.x === point.x && value.y === point.y)
        ? `<circle cx="${point.x * width}" cy="${point.y * height}" r="${radius}" fill="${color}"${filter}/>`
        : `<polyline points="${coordinates}" fill="none" stroke="${color}" stroke-width="${radius * 2}" stroke-linecap="round" stroke-linejoin="round"${filter}/>`;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${definitions.join("")}</defs><rect width="100%" height="100%" fill="black"/>${body}</svg>`;
}
