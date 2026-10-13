// What the file viewer needs from wherever a file lives. The Space Drive's is screens/drive/file-source.ts; an agent's or a project's instructions bring their own.
export type FileVersion = { ver: number; at?: number | string; by?: string | null; size?: number; deleted?: boolean; conflict?: boolean };
export type FileBody = { bytes?: ArrayLike<number>; base64?: string; text?: string; mime?: string };
export type SaveResult = { version?: number; conflict?: boolean } | void;

export type FileSource = {
  /** The file's bytes (or text), the head or one version. */
  load: (version?: number) => Promise<FileBody>;
  /** The versions, newest last. Absent: no version picker. */
  versions?: () => Promise<FileVersion[]>;
  /** Save text as a NEW version. `base` is the version it was edited from. Absent: read only. */
  save?: (text: string, base?: number) => Promise<SaveResult>;
};

