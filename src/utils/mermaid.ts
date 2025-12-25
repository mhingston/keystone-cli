import dagre from 'dagre';
import type { Workflow } from '../parser/schema';

export function generateMermaidGraph(workflow: Workflow): string {
  const lines = ['graph TD'];

  // 1. Add Nodes
  for (const step of workflow.steps) {
    // Sanitize ID for Mermaid
    const safeId = step.id.replace(/[^a-zA-Z0-9_]/g, '_');

    // Add type icon/label
    let label = `${step.id}\\n(${step.type})`;

    // Add specific details based on type
    if (step.type === 'llm') label = `${step.id}\\n🤖 ${step.agent}\\n(${step.type})`;
    if (step.foreach) label += '\\n(📚 Loop)';
    if (step.if) label += '\\n❓ Conditional';

    // Styling based on type
    let style = '';
    switch (step.type) {
      case 'llm':
        style = ':::ai';
        break;
      case 'human':
        style = ':::human';
        break;
      case 'shell':
        style = ':::shell';
        break;
      case 'file':
        style = ':::file';
        break;
      case 'request':
        style = ':::request';
        break;
      case 'workflow':
        style = ':::workflow';
        break;
      case 'engine':
        style = ':::engine';
        break;
      default:
        style = ':::default';
    }

    lines.push(`  ${safeId}["${label}"]${style}`);
  }

  // 2. Add Edges (Dependencies)
  for (const step of workflow.steps) {
    const safeId = step.id.replace(/[^a-zA-Z0-9_]/g, '_');

    if (step.needs && step.needs.length > 0) {
      for (const need of step.needs) {
        const safeNeed = need.replace(/[^a-zA-Z0-9_]/g, '_');
        lines.push(`  ${safeNeed} --> ${safeId}`);
      }
    }
  }

  // 3. Define Styles
  lines.push('  classDef ai fill:#e1f5fe,stroke:#01579b,stroke-width:2px;');
  lines.push(
    '  classDef human fill:#fff3e0,stroke:#e65100,stroke-width:2px,stroke-dasharray: 5 5;'
  );
  lines.push('  classDef shell fill:#f3e5f5,stroke:#4a148c,stroke-width:1px;');
  lines.push('  classDef file fill:#e8f5e9,stroke:#2e7d32,stroke-width:1px;');
  lines.push('  classDef request fill:#fffde7,stroke:#fbc02d,stroke-width:1px;');
  lines.push('  classDef workflow fill:#fce4ec,stroke:#c2185b,stroke-width:2px;');
  lines.push('  classDef engine fill:#e0f7fa,stroke:#006064,stroke-width:2px;');
  lines.push('  classDef default fill:#fff,stroke:#333,stroke-width:1px;');

  return lines.join('\n');
}

export function renderWorkflowAsAscii(workflow: Workflow): string {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 2, edgesep: 1, ranksep: 4 });
  g.setDefaultEdgeLabel(() => ({}));

  const nodeWidth = 24;
  const nodeHeight = 3;

  for (const step of workflow.steps) {
    let label = `${step.id} (${step.type})`;
    if (step.type === 'llm') label = `${step.id} (AI: ${step.agent})`;

    if (step.if) label = `IF ${label}`;
    if (step.foreach) label = `LOOP ${label}`;

    const width = Math.max(nodeWidth, label.length + 4);
    g.setNode(step.id, { label, width, height: nodeHeight });

    if (step.needs) {
      for (const need of step.needs) {
        g.setEdge(need, step.id);
      }
    }
  }

  dagre.layout(g);

  // Canvas dimensions
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const v of g.nodes()) {
    const node = g.node(v);
    minX = Math.min(minX, node.x - node.width / 2);
    minY = Math.min(minY, node.y - node.height / 2);
    maxX = Math.max(maxX, node.x + node.width / 2);
    maxY = Math.max(maxY, node.y + node.height / 2);
  }

  for (const e of g.edges()) {
    const edge = g.edge(e);
    for (const p of edge.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }

  const canvasWidth = Math.ceil(maxX - minX) + 10;
  const canvasHeight = Math.ceil(maxY - minY) + 4;
  const canvas = Array.from({ length: canvasHeight }, () => Array(canvasWidth).fill(' '));

  const offsetX = Math.floor(-minX) + 2;
  const offsetY = Math.floor(-minY) + 1;

  // Helper to draw at coordinates
  const draw = (x: number, y: number, char: string) => {
    const ix = Math.floor(x) + offsetX;
    const iy = Math.floor(y) + offsetY;
    if (iy >= 0 && iy < canvas.length && ix >= 0 && ix < canvas[0].length) {
      canvas[iy][ix] = char;
    }
  };

  const drawText = (x: number, y: number, text: string) => {
    const startX = Math.floor(x);
    const startY = Math.floor(y);
    for (let i = 0; i < text.length; i++) {
      draw(startX + i, startY, text[i]);
    }
  };

  // Draw Nodes
  for (const v of g.nodes()) {
    const node = g.node(v);
    const x = node.x - node.width / 2;
    const y = node.y - node.height / 2;
    const w = node.width;
    const h = node.height;

    const startX = Math.floor(x);
    const startY = Math.floor(y);
    const endX = startX + Math.floor(w) - 1;
    const endY = startY + Math.floor(h) - 1;

    for (let i = startX; i <= endX; i++) {
      draw(i, startY, '-');
      draw(i, endY, '-');
    }
    for (let i = startY; i <= endY; i++) {
      draw(startX, i, '|');
      draw(endX, i, '|');
    }
    draw(startX, startY, '+');
    draw(endX, startY, '+');
    draw(startX, endY, '+');
    draw(endX, endY, '+');

    const labelX = x + Math.floor((w - (node.label?.length || 0)) / 2);
    const labelY = y + Math.floor(h / 2);
    drawText(labelX, labelY, node.label || '');
  }

  // Draw Edges
  for (const e of g.edges()) {
    const edge = g.edge(e);
    const points = edge.points;

    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];

      const x1 = Math.floor(p1.x);
      const y1 = Math.floor(p1.y);
      const x2 = Math.floor(p2.x);
      const y2 = Math.floor(p2.y);

      if (x1 === x2) {
        for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) draw(x1, y, '|');
      } else if (y1 === y2) {
        for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) draw(x, y1, '-');
      } else {
        const xStep = x2 > x1 ? 1 : -1;
        const yStep = y2 > y1 ? 1 : -1;

        if (x1 !== x2) {
          for (let x = x1; x !== x2; x += xStep) {
            draw(x, y1, '-');
          }
          draw(x2, y1, '+');
        }
        if (y1 !== y2) {
          for (let y = y1 + yStep; y !== y2; y += yStep) {
            draw(x2, y, '|');
          }
        }
      }
    }

    const lastPoint = points[points.length - 1];
    const prevPoint = points[points.length - 2];
    if (lastPoint.x > prevPoint.x) draw(lastPoint.x, lastPoint.y, '>');
    else if (lastPoint.x < prevPoint.x) draw(lastPoint.x, lastPoint.y, '<');
    else if (lastPoint.y > prevPoint.y) draw(lastPoint.x, lastPoint.y, 'v');
    else if (lastPoint.y < prevPoint.y) draw(lastPoint.x, lastPoint.y, '^');
  }

  return canvas.map((row) => row.join('').trimEnd()).join('\n');
}
