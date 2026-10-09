// The resolved screen the box answers (lib/views/blocks.js): a layout of block keys and the blocks with their content. The app draws it and never reads a tool name.
export type Action = { id: string; title: string; outward?: boolean };
export type Block = { type: string; props?: Record<string, any>; content?: Record<string, any>; actions?: Action[]; data?: any; need?: any };
export type Node = { block?: string; col?: Node[]; row?: Node[]; grid?: Node[]; split?: Node[]; tabs?: Node[]; stack?: Node[]; gap?: string; weight?: number; label?: string };
export type Screen = { v: 2; kind?: string; id?: string; title?: string; from?: string; layout: Node; blocks: Record<string, Block>; surface?: string };

/** What a block can ask of its host. Ids and typed values only. */
export type Handlers = {
  open?: (block: string, row: any) => void;
  act?: (block: string, action: string, id?: string) => void;
  move?: (block: string, row: any, to: string) => void;
  filter?: (block: string, q: string, pill: string) => void;
  submit?: (block: string, form: string, values: Record<string, string>) => void;
};
