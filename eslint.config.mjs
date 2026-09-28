import { fixupPluginRules } from "@eslint/compat"
import { FlatCompat } from "@eslint/eslintrc"
import js from "@eslint/js"
import tsParser from "@typescript-eslint/parser"
import codegen from "eslint-plugin-codegen"
import _import from "eslint-plugin-import"
import simpleImportSort from "eslint-plugin-simple-import-sort"
import sortDestructureKeys from "eslint-plugin-sort-destructure-keys"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all
})

// Extension boundary. An extension lives in src/extensions/<name>/ and is attached only at
// the composition root (src/cli/**), so deleting that line and the folder leaves a working
// core. Anything may import src/extensions/Extension.ts; tests are unrestricted.
//
// `(^|/)extensions/X` for any X but Extension catches both `../extensions/s3/...` and the
// `imposters/extensions/s3/...` alias. Inside an extension, a relative import that climbs
// exactly to src/extensions/ and then names anything but Extension reaches a sibling
// extension; how many `../` that takes depends on the file's depth, so there is one block
// per depth. Import your own extension's files with `./`.
const intoAnExtension = "(^|/)extensions/(?!Extension(\\.js)?$)"
const notExtensionModule = "(?!\\.\\./|Extension(\\.js)?$)"
const extensionBoundary = (patterns) => ({ "no-restricted-imports": ["error", { patterns }] })
const MAX_EXTENSION_DEPTH = 6
const extensionBoundaryConfigs = [
  {
    files: ["src/**/*.ts"],
    ignores: ["src/extensions/**", "src/cli/**"],
    rules: extensionBoundary([{
      regex: intoAnExtension,
      message: "Only the composition root (src/cli/**) may import an extension; the core depends on src/extensions/Extension.ts alone."
    }])
  },
  {
    files: ["src/extensions/*.ts"],
    rules: extensionBoundary([{
      regex: `${intoAnExtension}|^\\./[^/]+/`,
      message: "The core-owned extension modules must not import an extension."
    }])
  },
  ...Array.from({ length: MAX_EXTENSION_DEPTH }, (_, depth) => ({
    files: [`src/extensions/*/${"*/".repeat(depth)}*.ts`],
    rules: extensionBoundary([{
      regex: `${intoAnExtension}|^(\\./)?(\\.\\./){${depth + 1}}${notExtensionModule}`,
      message: "Extensions must not import each other (import your own files with ./, the core with ../)."
    }])
  }))
]

export default [
  {
    ignores: ["**/dist", "**/build", "**/docs", "**/*.md"]
  },
  ...compat.extends(
    "eslint:recommended",
    "plugin:@typescript-eslint/eslint-recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@effect/recommended"
  ),
  {
    plugins: {
      import: fixupPluginRules(_import),
      "sort-destructure-keys": sortDestructureKeys,
      "simple-import-sort": simpleImportSort,
      codegen
    },

    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2018,
      sourceType: "module"
    },

    settings: {
      "import/parsers": {
        "@typescript-eslint/parser": [".ts", ".tsx"]
      },

      "import/resolver": {
        typescript: {
          alwaysTryTypes: true
        }
      }
    },

    rules: {
      "codegen/codegen": "error",
      "no-fallthrough": "off",
      "no-irregular-whitespace": "off",
      "object-shorthand": "error",
      "prefer-destructuring": "off",
      "sort-imports": "off",

      "no-restricted-syntax": ["error", {
        selector: "CallExpression[callee.property.name='push'] > SpreadElement.arguments",
        message: "Do not use spread arguments in Array.push"
      }],

      "no-unused-vars": "off",
      "prefer-rest-params": "off",
      "prefer-spread": "off",
      "import/first": "error",
      "import/newline-after-import": "error",
      "import/no-duplicates": "error",
      "import/no-unresolved": "off",
      "import/order": "off",
      "simple-import-sort/imports": "off",
      "sort-destructure-keys/sort-destructure-keys": "error",
      "deprecation/deprecation": "off",

      "@typescript-eslint/array-type": ["warn", {
        default: "generic",
        readonly: "generic"
      }],

      "@typescript-eslint/member-delimiter-style": 0,
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/ban-types": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-interface": "off",
      "@typescript-eslint/consistent-type-imports": "warn",

      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_"
      }],

      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/camelcase": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/interface-name-prefix": "off",
      "@typescript-eslint/no-array-constructor": "off",
      "@typescript-eslint/no-use-before-define": "off",
      "@typescript-eslint/no-namespace": "off",

      "@effect/dprint": ["error", {
        config: {
          indentWidth: 2,
          lineWidth: 120,
          semiColons: "asi",
          quoteStyle: "alwaysDouble",
          trailingCommas: "never",
          operatorPosition: "maintain",
          "arrowFunction.useParentheses": "force"
        }
      }]
    }
  },
  ...extensionBoundaryConfigs
]
