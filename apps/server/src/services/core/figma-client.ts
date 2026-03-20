/**
 * Thin HTTP client for the Figma REST API.
 *
 * Uses native `fetch` — no additional dependencies.
 * All methods return the raw API response as typed `unknown` so callers
 * (MCP tools) can forward it directly to the agent without re-shaping.
 *
 * @module services/core/figma-client
 */

const FIGMA_API_BASE = 'https://api.figma.com/v1';

/** Options passed to the {@link FigmaClient} constructor. */
export interface FigmaClientOptions {
  /** Figma Personal Access Token (Settings → Security → Personal access tokens). */
  accessToken: string;
}

/** Options for {@link FigmaClient.getFile}. */
export interface GetFileOptions {
  /**
   * How many levels deep to traverse the document tree.
   * Lower values return faster responses. Omit for the full tree.
   */
  depth?: number;
  /**
   * Return only the listed node IDs and their children.
   * Useful for large files where you only need specific frames.
   */
  ids?: string[];
}

/** Options for {@link FigmaClient.getNodes}. */
export interface GetNodesOptions {
  /** How many levels deep to traverse each node's subtree. */
  depth?: number;
}

/** Image export format for {@link FigmaClient.getImages}. */
export type ImageFormat = 'svg' | 'png' | 'jpg' | 'pdf';

/** Options for {@link FigmaClient.getImages}. */
export interface GetImagesOptions {
  /**
   * Export format. Defaults to `svg`.
   * SVG is preferred for design-to-code workflows — it carries exact geometry
   * and is text-based so agents can read and transform it directly.
   */
  format?: ImageFormat;
  /**
   * Image scale multiplier for raster formats (1–4). Ignored for SVG/PDF.
   * Default: 1.
   */
  scale?: number;
  /**
   * Include node `id` attributes in SVG output.
   * Useful for correlating SVG elements back to Figma node IDs.
   */
  svgIncludeId?: boolean;
  /**
   * Simplify inside/outside strokes to centre strokes in SVG output.
   * Default: true.
   */
  svgSimplifyStroke?: boolean;
  /**
   * Use the node's absolute bounding box for export.
   * When false (default), uses the cropped bounding box.
   */
  useAbsoluteBounds?: boolean;
}

/**
 * Thin HTTP client for the Figma REST API.
 *
 * All methods correspond 1:1 to Figma v1 endpoints and return the raw
 * response JSON without any transformation. Error responses throw with
 * the HTTP status and body included in the message.
 */
export class FigmaClient {
  private readonly headers: HeadersInit;

  constructor(opts: FigmaClientOptions) {
    this.headers = { 'X-Figma-Token': opts.accessToken };
  }

  /**
   * Fetch the full document tree for a Figma file.
   *
   * Use `depth` to limit traversal and `ids` to fetch only specific top-level
   * frames. Large files should always use one of these options to avoid
   * multi-MB responses.
   *
   * @param fileKey - The alphanumeric file key from the Figma URL
   */
  async getFile(fileKey: string, opts?: GetFileOptions): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.depth !== undefined) params.set('depth', String(opts.depth));
    if (opts?.ids?.length) params.set('ids', opts.ids.join(','));
    return this.get(`/files/${fileKey}${params.size ? `?${params}` : ''}`);
  }

  /**
   * Fetch one or more specific nodes and their subtrees.
   *
   * Returns full property data for each node including fills, strokes,
   * typography, effects, constraints, and layout information — the primary
   * source of truth for design-to-code translation.
   *
   * @param fileKey - The file that contains the nodes
   * @param nodeIds - Array of node IDs (find them in the Figma URL when a node is selected)
   */
  async getNodes(
    fileKey: string,
    nodeIds: string[],
    opts?: GetNodesOptions,
  ): Promise<unknown> {
    const params = new URLSearchParams({ ids: nodeIds.join(',') });
    if (opts?.depth !== undefined) params.set('depth', String(opts.depth));
    return this.get(`/files/${fileKey}/nodes?${params}`);
  }

  /**
   * List all published components in a file.
   *
   * Returns component metadata including name, description, key, and node ID.
   * Use `getNodes` with the node ID to retrieve full component properties.
   *
   * @param fileKey - The file to list components from
   */
  async getFileComponents(fileKey: string): Promise<unknown> {
    return this.get(`/files/${fileKey}/components`);
  }

  /**
   * List all published styles in a file (colours, text, effects, grids).
   *
   * Design styles are the source of truth for design tokens — colours,
   * typography scales, shadows, and layout grids. Use this to extract
   * the token system before generating CSS variables or theme files.
   *
   * @param fileKey - The file to list styles from
   */
  async getFileStyles(fileKey: string): Promise<unknown> {
    return this.get(`/files/${fileKey}/styles`);
  }

  /**
   * Export rendered images for a set of nodes.
   *
   * Returns a map of `{ nodeId → imageUrl }`. The URLs expire after a short
   * window — fetch the images promptly after calling this method.
   *
   * Prefer `format: 'svg'` for design-to-code: SVG output is text-based,
   * retains exact geometry, and can be read and transformed by the agent
   * without losing fidelity.
   *
   * @param fileKey - The file that contains the nodes
   * @param nodeIds - Array of node IDs to export
   */
  async getImages(
    fileKey: string,
    nodeIds: string[],
    opts?: GetImagesOptions,
  ): Promise<unknown> {
    const params = new URLSearchParams({ ids: nodeIds.join(',') });
    if (opts?.format) params.set('format', opts.format);
    if (opts?.scale !== undefined) params.set('scale', String(opts.scale));
    if (opts?.svgIncludeId) params.set('svg_include_id', 'true');
    if (opts?.svgSimplifyStroke !== undefined)
      params.set('svg_simplify_stroke', String(opts.svgSimplifyStroke));
    if (opts?.useAbsoluteBounds) params.set('use_absolute_bounds', 'true');
    return this.get(`/images/${fileKey}?${params}`);
  }

  /**
   * List comments on a file.
   *
   * Useful for reading design feedback and open questions attached to frames.
   *
   * @param fileKey - The file to list comments from
   */
  async getFileComments(fileKey: string): Promise<unknown> {
    return this.get(`/files/${fileKey}/comments`);
  }

  // === Private ===

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${FIGMA_API_BASE}${path}`, { headers: this.headers });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Figma API ${res.status}: ${body}`);
    }
    return res.json() as Promise<unknown>;
  }
}
