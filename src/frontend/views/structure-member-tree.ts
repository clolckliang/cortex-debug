/**
 * Tree Data Provider for Structure Member Selection
 */

import * as vscode from 'vscode';
import { StructMember, ParsedStructure } from './struct-parser';

export class StructureMemberTreeItem extends vscode.TreeItem {
    constructor(
        public readonly member: StructMember,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        super(member.path, collapsibleState);
        this.tooltip = `${member.name}: ${member.value} (${member.type})`;
        this.description = `${member.type} = ${member.value}`;
        this.contextValue = member.numericValue !== undefined ? 'numericMember' : 'nonNumericMember';

        if (member.children && member.children.length > 0) {
            this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        }

        // Add checkbox for numeric members
        if (member.numericValue !== undefined) {
            this.contextValue = 'selectableMember';
        }
    }
}

export class StructureMemberTreeDataProvider
implements vscode.TreeDataProvider<StructureMemberTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<
        StructureMemberTreeItem | undefined | null | void
    > = new vscode.EventEmitter<StructureMemberTreeItem | undefined | null | void>();

    readonly onDidChangeTreeData: vscode.Event<
        StructureMemberTreeItem | undefined | null | void
    > = this._onDidChangeTreeData.event;

    constructor(private parsedStructure: ParsedStructure) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: StructureMemberTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: StructureMemberTreeItem): Thenable<StructureMemberTreeItem[]> {
        if (!element) {
            // Root level - return all top-level members
            return Promise.resolve(
                this.parsedStructure.members.map((member) =>
                    new StructureMemberTreeItem(member,
                        member.children && member.children.length > 0
                            ? vscode.TreeItemCollapsibleState.Expanded
                            : vscode.TreeItemCollapsibleState.None
                    )
                )
            );
        } else {
            // Child level - return children of the current member
            if (element.member.children && element.member.children.length > 0) {
                return Promise.resolve(
                    element.member.children.map((child) =>
                        new StructureMemberTreeItem(child,
                            child.children && child.children.length > 0
                                ? vscode.TreeItemCollapsibleState.Expanded
                                : vscode.TreeItemCollapsibleState.None
                        )
                    )
                );
            }
            return Promise.resolve([]);
        }
    }

    getAllNumericMembers(): StructMember[] {
        const numericMembers: StructMember[] = [];

        const collectNumericMembers = (members: StructMember[]) => {
            for (const member of members) {
                if (member.numericValue !== undefined) {
                    numericMembers.push(member);
                }
                if (member.children && member.children.length > 0) {
                    collectNumericMembers(member.children);
                }
            }
        };

        collectNumericMembers(this.parsedStructure.members);
        return numericMembers;
    }

    findMemberByPath(path: string): StructMember | null {
        const findInMembers = (members: StructMember[], targetPath: string): StructMember | null => {
            for (const member of members) {
                if (member.path === targetPath) {
                    return member;
                }
                if (member.children && member.children.length > 0) {
                    const found = findInMembers(member.children, targetPath);
                    if (found) return found;
                }
            }
            return null;
        };

        return findInMembers(this.parsedStructure.members, path);
    }
}
