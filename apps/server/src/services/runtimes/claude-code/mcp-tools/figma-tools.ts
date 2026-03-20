/**
 * Figma MCP tools.
 *
 * Exposes the Figma REST API to DorkOS agents via MCP so they can read
 * design files, extract node properties, retrieve design tokens, and export
 * SVG/PNG renders — giving them the real specs needed for accurate
 * design-to-code translation instead of guessing from HTML screenshots.
 *
 * All tools are disabled (return FIGMA_DISABLED) when no Figma access token
 * is configured. The dependency is injected via {@link McpToolDeps}.
 *
 * @module services/runtimes/claude-code/mcp-tools/figma-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

/** Guard that returns an error response when Figma is not configured. */
function requireFigma(deps: McpToolDeps) {
  if (!deps.figmaClient) {
    return jsonContent(
      { error: 'Figma is not configured. Set FIGMA_ACCESS_TOKEN to enable.', code: 'FIGMA_DISABLED' },
      true,
    );
  }
  return null;
}

// === Handler factories ===

/**
 * Fetch a Figma file's document tree and metadata.
 *
 * Returns the raw Figma API response including the full document tree,
 * component map, style map, and file metadata. Use `depth` to limit
 * how many levels of the tree are returned — essential for large files.
 */
export function createFigmaGetFileHandler(deps: McpToolDeps) {
  return async (args: { file_key: string; depth?: number; node_ids?: string[] }) => {
    const err = requireFigma(deps);
    if (err) return err;
    try {
      const data = await deps.figmaClient!.getFile(args.file_key, {
        depth: args.depth,
        ids: args.node_ids,
      });
      return jsonContent(data);
    } catch (e) {
      return jsonContent({ error: e instanceof Error ? e.message : String(e), code: 'FIGMA_ERROR' }, true);
    }
  };
}

/**
 * Fetch specific nodes from a Figma file with full property data.
 *
 * Returns fills, strokes, typography, effects, constraints, layout, and
 * children for each requested node. This is the primary tool for
 * design-to-code translation — use it after identifying target node IDs
 * from figma_get_file or the Figma URL (?node-id=...).
 */
export function createFigmaGetNodesHandler(deps: McpToolDeps) {
  return async (args: { file_key: string; node_ids: string[]; depth?: number }) => {
    const err = requireFigma(deps);
    if (err) return err;
    try {
      const data = await deps.figmaClient!.getNodes(args.file_key, args.node_ids, {
        depth: args.depth,
      });
      return jsonContent(data);
    } catch (e) {
      return jsonContent({ error: e instanceof Error ? e.message : String(e), code: 'FIGMA_ERROR' }, true);
    }
  };
}

/**
 * List all published components in a Figma file.
 *
 * Returns component metadata: name, description, key, and node ID.
 * Use the node ID with figma_get_nodes to retrieve the full component tree
 * and property values.
 */
export function createFigmaGetComponentsHandler(deps: McpToolDeps) {
  return async (args: { file_key: string }) => {
    const err = requireFigma(deps);
    if (err) return err;
    try {
      const data = await deps.figmaClient!.getFileComponents(args.file_key);
      return jsonContent(data);
    } catch (e) {
      return jsonContent({ error: e instanceof Error ? e.message : String(e), code: 'FIGMA_ERROR' }, true);
    }
  };
}

/**
 * Fetch all design styles (colours, typography, effects, grids) from a file.
 *
 * Design styles are the source of truth for design tokens. Use this to
 * extract the full colour palette, type scale, shadow system, and layout
 * grids before generating CSS custom properties, Tailwind config, or
 * theme files.
 */
export function createFigmaGetStylesHandler(deps: McpToolDeps) {
  return async (args: { file_key: string }) => {
    const err = requireFigma(deps);
    if (err) return err;
    try {
      const data = await deps.figmaClient!.getFileStyles(args.file_key);
      return jsonContent(data);
    } catch (e) {
      return jsonContent({ error: e instanceof Error ? e.message : String(e), code: 'FIGMA_ERROR' }, true);
    }
  };
}

/**
 * Export rendered images for specific Figma nodes.
 *
 * Returns a map of { nodeId → signed image URL }. URLs expire after ~14 days
 * so fetch them promptly.
 *
 * Prefer format='svg' for design-to-code: SVG output is text-based, retains
 * exact geometry, and can be read and manipulated directly. Use 'png' when
 * you need a pixel-accurate reference image for visual comparison.
 */
export function createFigmaGetImagesHandler(deps: McpToolDeps) {
  return async (args: {
    file_key: string;
    node_ids: string[];
    format?: 'svg' | 'png' | 'jpg' | 'pdf';
    scale?: number;
    svg_include_id?: boolean;
  }) => {
    const err = requireFigma(deps);
    if (err) return err;
    try {
      const data = await deps.figmaClient!.getImages(args.file_key, args.node_ids, {
        format: args.format ?? 'svg',
        scale: args.scale,
        svgIncludeId: args.svg_include_id,
      });
      return jsonContent(data);
    } catch (e) {
      return jsonContent({ error: e instanceof Error ? e.message : String(e), code: 'FIGMA_ERROR' }, true);
    }
  };
}

/**
 * List comments on a Figma file.
 *
 * Returns all comments including author, position, resolved state, and
 * message text. Useful for reading design feedback attached to frames.
 */
export function createFigmaGetCommentsHandler(deps: McpToolDeps) {
  return async (args: { file_key: string }) => {
    const err = requireFigma(deps);
    if (err) return err;
    try {
      const data = await deps.figmaClient!.getFileComments(args.file_key);
      return jsonContent(data);
    } catch (e) {
      return jsonContent({ error: e instanceof Error ? e.message : String(e), code: 'FIGMA_ERROR' }, true);
    }
  };
}

// === Tool registration ===

/** Returns the Figma tool definitions — only when figmaClient is provided. */
export function getFigmaTools(deps: McpToolDeps) {
  if (!deps.figmaClient) return [];

  return [
    tool(
      'figma_get_file',
      'Fetch a Figma file\'s document tree and metadata. Returns the full node hierarchy, component map, and style map. ' +
      'Always pass depth=2 or depth=3 first to get an overview; drill into specific nodes with figma_get_nodes. ' +
      'Find the file_key in the Figma URL: figma.com/design/{file_key}/...',
      {
        file_key: z.string().describe('Figma file key from the URL (e.g. "aBcDeFgHiJkL")'),
        depth: z.number().int().min(1).max(10).optional().describe(
          'Tree depth limit. Use 2-3 for an overview, omit for the full tree. Highly recommended for large files.',
        ),
        node_ids: z.array(z.string()).optional().describe(
          'Limit response to these top-level node IDs and their children. Comma-separated IDs from the Figma URL.',
        ),
      },
      createFigmaGetFileHandler(deps),
    ),

    tool(
      'figma_get_nodes',
      'Fetch specific Figma nodes with full property data: fills, strokes, typography, effects, constraints, auto-layout, and children. ' +
      'This is the primary tool for design-to-code — call it with the frame or component node IDs you want to implement. ' +
      'Node IDs appear in the Figma URL as ?node-id=123%3A456 (decode to "123:456").',
      {
        file_key: z.string().describe('Figma file key from the URL'),
        node_ids: z.array(z.string()).describe(
          'Node IDs to fetch (e.g. ["123:456", "789:012"]). Get IDs from figma_get_file or the Figma URL.',
        ),
        depth: z.number().int().min(1).max(10).optional().describe(
          'How deep to traverse each node\'s children. Omit for full subtree.',
        ),
      },
      createFigmaGetNodesHandler(deps),
    ),

    tool(
      'figma_get_components',
      'List all published components in a Figma file with their name, description, key, and node ID. ' +
      'Use this to discover the component library before implementing a design system. ' +
      'Follow up with figma_get_nodes using the node_id to get full property details.',
      {
        file_key: z.string().describe('Figma file key from the URL'),
      },
      createFigmaGetComponentsHandler(deps),
    ),

    tool(
      'figma_get_styles',
      'Fetch all design styles from a Figma file: colour styles, text styles, effect styles (shadows, blurs), and grid styles. ' +
      'Design styles are the source of truth for design tokens — use this before generating CSS variables, ' +
      'a Tailwind config, or any theme file. Returns style metadata; use figma_get_nodes with the style node ID for full paint/type values.',
      {
        file_key: z.string().describe('Figma file key from the URL'),
      },
      createFigmaGetStylesHandler(deps),
    ),

    tool(
      'figma_get_images',
      'Export rendered images for specific Figma nodes. Returns signed URLs that expire in ~14 days — fetch promptly. ' +
      'Prefer format="svg" for design-to-code: SVG is text-based, retains exact geometry, and can be read directly. ' +
      'Use format="png" for visual reference when comparing implementation to design.',
      {
        file_key: z.string().describe('Figma file key from the URL'),
        node_ids: z.array(z.string()).describe('Node IDs to export'),
        format: z.enum(['svg', 'png', 'jpg', 'pdf']).optional().describe(
          'Export format. Default: svg. Prefer svg for code generation.',
        ),
        scale: z.number().min(0.01).max(4).optional().describe(
          'Scale multiplier for raster formats (1–4). Ignored for svg/pdf.',
        ),
        svg_include_id: z.boolean().optional().describe(
          'Include Figma node IDs as id attributes in SVG output for traceability.',
        ),
      },
      createFigmaGetImagesHandler(deps),
    ),

    tool(
      'figma_get_comments',
      'List all comments on a Figma file, including author, position, resolved state, and message text. ' +
      'Use this to read design feedback and open questions attached to frames.',
      {
        file_key: z.string().describe('Figma file key from the URL'),
      },
      createFigmaGetCommentsHandler(deps),
    ),
  ];
}
