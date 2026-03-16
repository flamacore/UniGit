import type { BranchEntry } from "../../features/repositories/api";
import type { BranchTreeNode } from "../types";

export const buildBranchTree = (entries: BranchEntry[], scope: string): BranchTreeNode[] => {
  const roots: Array<BranchTreeNode & { childMap: Map<string, BranchTreeNode & { childMap: Map<string, any> }> }> = [];
  const rootMap = new Map<string, BranchTreeNode & { childMap: Map<string, any> }>();

  const ensureNode = (
    parentChildren: Array<BranchTreeNode & { childMap: Map<string, any> }>,
    parentMap: Map<string, BranchTreeNode & { childMap: Map<string, any> }>,
    id: string,
    label: string,
  ) => {
    let node = parentMap.get(id);

    if (!node) {
      node = {
        id,
        label,
        branch: null,
        children: [],
        childMap: new Map(),
      };
      parentMap.set(id, node);
      parentChildren.push(node);
    }

    return node;
  };

  for (const branch of entries) {
    const branchSegments = branch.name.split("/").filter(Boolean);
    const segments = branchSegments.length <= 1 ? ["root", ...branchSegments] : branchSegments;
    let currentChildren = roots;
    let currentMap = rootMap;
    let path = scope;

    segments.forEach((segment, index) => {
      path = `${path}/${segment}`;
      const node = ensureNode(currentChildren, currentMap, path, segment);

      if (index === segments.length - 1) {
        node.branch = branch;
      }

      currentChildren = node.children as Array<BranchTreeNode & { childMap: Map<string, any> }>;
      currentMap = node.childMap;
    });
  }

  const sortNodes = (nodes: Array<BranchTreeNode & { childMap?: Map<string, any> }>): BranchTreeNode[] => {
    return nodes
      .sort((left, right) => {
        const leftFolder = left.children.length > 0;
        const rightFolder = right.children.length > 0;

        if (leftFolder !== rightFolder) {
          return leftFolder ? -1 : 1;
        }

        return left.label.localeCompare(right.label);
      })
      .map((node) => ({
        id: node.id,
        label: node.label,
        branch: node.branch,
        children: sortNodes(node.children as Array<BranchTreeNode & { childMap?: Map<string, any> }>),
      }));
  };

  return sortNodes(roots);
};