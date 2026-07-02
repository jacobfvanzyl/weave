export type LanguageCommentTokens = {
  line?: string;
  block?: { open: string; close: string };
};

export type LanguagePack = {
  id: string;
  label: string;
  match: {
    extensions?: string[];
    filenames?: string[];
    patterns?: RegExp[];
  };
  comments?: LanguageCommentTokens;
  lsp?: {
    languageId: string;
    startInEditor?: boolean;
    defaultServerIds?: string[];
  };
};

const cStyleComments = {
  line: "//",
  block: { open: "/*", close: "*/" },
} satisfies LanguageCommentTokens;

const htmlComments = {
  block: { open: "<!--", close: "-->" },
} satisfies LanguageCommentTokens;

const hashComments = {
  line: "#",
} satisfies LanguageCommentTokens;

export const languagePacks: readonly LanguagePack[] = [
  {
    id: "typescriptreact",
    label: "TSX",
    match: { extensions: ["tsx"] },
    comments: cStyleComments,
    lsp: {
      languageId: "typescriptreact",
      defaultServerIds: ["typescript", "biome"],
    },
  },
  {
    id: "typescript",
    label: "TypeScript",
    match: { extensions: ["ts", "mts", "cts"] },
    comments: cStyleComments,
    lsp: {
      languageId: "typescript",
      defaultServerIds: ["typescript", "biome"],
    },
  },
  {
    id: "javascriptreact",
    label: "JSX",
    match: { extensions: ["jsx"] },
    comments: cStyleComments,
    lsp: {
      languageId: "javascriptreact",
      defaultServerIds: ["typescript", "biome"],
    },
  },
  {
    id: "javascript",
    label: "JavaScript",
    match: { extensions: ["js", "mjs", "cjs"] },
    comments: cStyleComments,
    lsp: {
      languageId: "javascript",
      defaultServerIds: ["typescript", "biome"],
    },
  },
  {
    id: "jsonc",
    label: "JSONC",
    match: { extensions: ["jsonc"] },
    comments: cStyleComments,
    lsp: {
      languageId: "jsonc",
      defaultServerIds: ["json", "biome"],
    },
  },
  {
    id: "json",
    label: "JSON",
    match: { extensions: ["json"] },
    lsp: {
      languageId: "json",
      defaultServerIds: ["json", "biome"],
    },
  },
  {
    id: "css",
    label: "CSS",
    match: { extensions: ["css"] },
    comments: { block: { open: "/*", close: "*/" } },
    lsp: {
      languageId: "css",
      defaultServerIds: ["css", "biome"],
    },
  },
  {
    id: "scss",
    label: "SCSS",
    match: { extensions: ["scss"] },
    comments: { block: { open: "/*", close: "*/" } },
  },
  {
    id: "sass",
    label: "Sass",
    match: { extensions: ["sass"] },
    comments: { block: { open: "/*", close: "*/" } },
  },
  {
    id: "less",
    label: "Less",
    match: { extensions: ["less"] },
    comments: { block: { open: "/*", close: "*/" } },
  },
  {
    id: "html",
    label: "HTML",
    match: { extensions: ["html", "htm"] },
    comments: htmlComments,
    lsp: {
      languageId: "html",
      defaultServerIds: ["html"],
    },
  },
  {
    id: "xml",
    label: "XML",
    match: { extensions: ["xml"] },
    comments: htmlComments,
  },
  {
    id: "svg",
    label: "SVG",
    match: { extensions: ["svg"] },
    comments: htmlComments,
  },
  {
    id: "markdown",
    label: "Markdown",
    match: { extensions: ["md", "mdx", "markdown"] },
    comments: htmlComments,
    lsp: {
      languageId: "markdown",
      defaultServerIds: ["markdown"],
    },
  },
  {
    id: "dart",
    label: "Dart",
    match: { extensions: ["dart"] },
    comments: cStyleComments,
    lsp: {
      languageId: "dart",
      defaultServerIds: ["dart"],
    },
  },
  {
    id: "graphql",
    label: "GraphQL",
    match: { extensions: ["graphql", "gql"] },
    comments: hashComments,
    lsp: {
      languageId: "graphql",
      defaultServerIds: ["biome"],
    },
  },
  {
    id: "yaml",
    label: "YAML",
    match: { extensions: ["yaml", "yml"] },
    comments: hashComments,
  },
  {
    id: "env",
    label: "Environment",
    match: {
      extensions: ["env"],
      filenames: [".env"],
      patterns: [/(^|\/)\.env\.[^/]+$/],
    },
    comments: hashComments,
  },
];

const normalizeMatcherValue = (value: string) =>
  value.trim().replace(/^\./, "").toLowerCase();

export const normalizeLanguagePath = (filePath: string | undefined) =>
  (filePath ?? "").split(/[?#]/, 1)[0].replace(/\\/g, "/").toLowerCase();

export const getLanguageFilename = (filePath: string | undefined) => {
  const normalized = normalizeLanguagePath(filePath);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
};

export const getLanguageFileExtension = (filePath: string | undefined) => {
  const filename = getLanguageFilename(filePath);
  if (!filename || filename === "." || filename === "..") return undefined;
  const index = filename.lastIndexOf(".");
  if (index <= 0 || index === filename.length - 1) return undefined;
  return filename.slice(index + 1);
};

export const matchesLanguagePack = (
  pack: LanguagePack,
  filePath: string | undefined,
) => {
  const normalizedPath = normalizeLanguagePath(filePath);
  const filename = getLanguageFilename(normalizedPath);
  const extension = getLanguageFileExtension(normalizedPath);

  if (
    extension &&
    pack.match.extensions?.some((candidate) =>
      normalizeMatcherValue(candidate) === extension
    )
  ) {
    return true;
  }

  if (
    filename &&
    pack.match.filenames?.some((candidate) =>
      candidate.toLowerCase() === filename
    )
  ) {
    return true;
  }

  return Boolean(
    pack.match.patterns?.some((pattern) => pattern.test(normalizedPath)),
  );
};

export const findLanguagePack = (filePath: string | undefined) =>
  languagePacks.find((pack) => matchesLanguagePack(pack, filePath));

export const findLanguagePacksWithLsp = () =>
  languagePacks.filter((pack) => pack.lsp);

export const detectLanguagePackLspId = (filePath: string | undefined) => {
  const pack = findLanguagePack(filePath);
  if (pack?.lsp?.startInEditor === false) return undefined;
  return pack?.lsp?.languageId;
};
