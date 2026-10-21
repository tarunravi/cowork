import { expect, test } from "bun:test";
import ts from "typescript";

const source = await Bun.file(
  new URL("../../mobile/app/computer.tsx", import.meta.url),
).text();
const file = ts.createSourceFile(
  "computer.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

test("mobile never takes ownership from an effect or sends ordinary human gestures", () => {
  const effectCalls: string[] = [];
  const humanPaths: string[] = [];
  walk(file, (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(file) === "useEffect"
    ) {
      walk(node, (child) => {
        if (ts.isCallExpression(child))
          effectCalls.push(child.expression.getText(file));
      });
    }
    if (ts.isStringLiteralLike(node) && node.text.includes("/human/"))
      humanPaths.push(node.text);
  });
  expect(effectCalls).not.toContain("take");
  expect(effectCalls).not.toContain("action.run");
  expect(humanPaths).toEqual(["/human/secret"]);
  expect(source).not.toContain("<Pressable");
  expect(source).toContain("The screen is read-only.");
  expect(source).toContain("control?.canControl ?");
  expect(source).toContain('title="Return control to the Bot"');
});

test("mobile exit releases only control taken by this visit, while explicit return can release an observed holder", () => {
  expect(source).toContain('const takenRequestId = useRef("");');
  expect(source).toMatch(
    /await api<ControlState>\(path\(botId, "\/control\/take"\), \{\s*method: "POST",\s*body: \{ requestId: id \},\s*\}\);\s*takenRequestId\.current = id;/,
  );

  const cleanup = source.slice(
    source.indexOf("release.current = () => {"),
    source.indexOf("useEffect(() => () => release.current(), []);"),
  );
  expect(cleanup).toContain(
    'if (takenRequestId.current && control?.holder === "human")',
  );
  expect(cleanup).toContain('path(botId, "/control/release")');
  expect(cleanup).toContain("body: { requestId: takenRequestId.current }");
  expect(cleanup).not.toContain("control?.request?.id");

  const explicitReturn = source.slice(
    source.indexOf('title="Return control to the Bot"'),
    source.indexOf('title="Take control"'),
  );
  expect(explicitReturn).toContain('path(botId, "/control/release")');
  expect(explicitReturn).toContain(
    "body: { requestId: control?.request?.id || requestId }",
  );
  expect(explicitReturn).not.toContain("if (takenRequestId.current");
  expect(explicitReturn).toContain('takenRequestId.current = "";');
});
