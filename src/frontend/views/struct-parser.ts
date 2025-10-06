/**
 * Advanced Structure Parser for Waveform Visualization
 *
 * This module provides comprehensive parsing for complex C/C++ data structures
 * including nested structs, unions, arrays, and member selection.
 */

export interface StructMember {
    name: string;
    path: string;           // Dot-notation path (e.g., "member1.nested.value")
    value: any;
    type: string;
    isStruct: boolean;
    isUnion: boolean;
    isArray: boolean;
    children?: StructMember[];
    numericValue?: number;  // Extracted numeric value for waveform
}

export interface ParsedStructure {
    name: string;
    type: 'struct' | 'union' | 'class' | 'unknown';
    members: StructMember[];
    totalValue: number;     // Combined numeric value
    hash: string;           // Unique hash for change detection
}

export interface MemberSelection {
    path: string;
    name: string;
    selected: boolean;
    color?: string;
}

export class StructParser {
    /**
     * Parse a complex structure value from GDB/LiveWatch output
     */
    public parseStructure(structValue: string, name: string): ParsedStructure | null {
        if (!structValue || structValue === 'not available') {
            return null;
        }

        console.log(`[StructParser] Parsing structure: ${name}, value: ${structValue}`);

        // Handle simplified structure representation - return null to indicate expansion is needed
        if (structValue === '{...}' || structValue === '...') {
            console.log(`[StructParser] Detected simplified structure representation for ${name} - expansion required`);
            return null;
        }

        try {
            // Determine structure type
            const type = this.detectStructureType(structValue);

            // Parse based on format
            let members: StructMember[] = [];

            if (structValue.startsWith('{') && structValue.endsWith('}')) {
                members = this.parseStructMembers(structValue, name);
            } else if (structValue.includes('<') && structValue.includes('>')) {
                // Handle union representation like "union_value { member = value }"
                members = this.parseUnionMembers(structValue, name);
            } else if (this.isArrayRepresentation(structValue)) {
                members = this.parseArrayMembers(structValue, name);
            } else {
                // Fallback: treat as simple value or enum
                members = this.parseSimpleValue(structValue, name);
            }

            // Calculate total value and hash
            const totalValue = this.calculateTotalValue(members);
            const hash = this.calculateHash(members);

            return {
                name,
                type,
                members,
                totalValue,
                hash
            };
        } catch (error) {
            console.error(`[StructParser] Error parsing structure ${name}:`, error);
            return this.createFallbackStructure(name, structValue);
        }
    }

    private createSimplifiedStructure(name: string, structValue: string): ParsedStructure {
        console.log(`[StructParser] Creating simplified structure for ${name}`);

        // Create a placeholder structure with minimal information
        const members: StructMember[] = [{
            name: 'value',
            path: 'value',
            value: structValue,
            type: 'simplified',
            isStruct: false,
            isUnion: false,
            isArray: false,
            numericValue: 0 // Default value for simplified structures
        }];

        return {
            name,
            type: 'unknown',
            members,
            totalValue: 0,
            hash: this.calculateSimpleHash(structValue)
        };
    }

    /**
     * Extract numeric value for a specific member path
     */
    public extractMemberValue(parsed: ParsedStructure, memberPath: string): number | null {
        const member = this.findMemberByPath(parsed.members, memberPath);
        if (member && member.numericValue !== undefined) {
            return member.numericValue;
        }
        return null;
    }

    /**
     * Get all selectable numeric members from a structure
     */
    public getNumericMembers(parsed: ParsedStructure): MemberSelection[] {
        const selections: MemberSelection[] = [];

        const collectNumericMembers = (members: StructMember[], parentPath: string = '') => {
            for (const member of members) {
                const currentPath = parentPath ? `${parentPath}.${member.name}` : member.name;

                if (member.numericValue !== undefined) {
                    selections.push({
                        path: currentPath,
                        name: member.name,
                        selected: false
                    });
                }

                if (member.children && member.children.length > 0) {
                    collectNumericMembers(member.children, currentPath);
                }
            }
        };

        collectNumericMembers(parsed.members);
        return selections;
    }

    /**
     * Generate member expressions for debugging
     */
    public generateMemberExpressions(structName: string, selections: MemberSelection[]): string[] {
        return selections
            .filter((sel) => sel.selected)
            .map((sel) => `${structName}.${sel.path}`);
    }

    private detectStructureType(structValue: string): 'struct' | 'union' | 'class' | 'unknown' {
        const lowerValue = structValue.toLowerCase();

        if (lowerValue.includes('union') || lowerValue.includes('<')) {
            return 'union';
        } else if (lowerValue.includes('class')) {
            return 'class';
        } else if (lowerValue.includes('{') && lowerValue.includes('}')) {
            return 'struct';
        }

        return 'unknown';
    }

    private parseStructMembers(structValue: string, parentName: string): StructMember[] {
        const members: StructMember[] = [];

        // Remove outer braces
        const content = structValue.slice(1, -1).trim();

        // Split by commas, but handle nested structures
        const memberStrings = this.splitNestedStructures(content);

        for (const memberStr of memberStrings) {
            const member = this.parseSingleMember(memberStr, parentName);
            if (member) {
                members.push(member);
            }
        }

        return members;
    }

    private parseUnionMembers(unionValue: string, parentName: string): StructMember[] {
        const members: StructMember[] = [];

        // Handle union format: "union_name { active_member = value }"
        const activeMemberMatch = unionValue.match(/\{([^=]+)=\s*([^}]+)\}/);
        if (activeMemberMatch) {
            const memberName = activeMemberMatch[1].trim();
            const memberValue = activeMemberMatch[2].trim();

            const member: StructMember = {
                name: memberName,
                path: memberName,
                value: memberValue,
                type: 'unknown',
                isStruct: false,
                isUnion: true,
                isArray: false,
                numericValue: this.extractNumericValue(memberValue)
            };

            members.push(member);
        }

        return members;
    }

    private parseArrayMembers(arrayValue: string, parentName: string): StructMember[] {
        const members: StructMember[] = [];

        // Handle array format: "{[0] = value, [1] = value, ...}"
        const elementMatches = arrayValue.match(/\[(\d+)\]\s*=\s*([^,}]+)/g);

        if (elementMatches) {
            for (const elementStr of elementMatches) {
                const match = elementStr.match(/\[(\d+)\]\s*=\s*([^,}]+)/);
                if (match) {
                    const index = match[1];
                    const value = match[2].trim();

                    const member: StructMember = {
                        name: `[${index}]`,
                        path: `[${index}]`,
                        value: value,
                        type: 'array_element',
                        isStruct: false,
                        isUnion: false,
                        isArray: true,
                        numericValue: this.extractNumericValue(value)
                    };

                    members.push(member);
                }
            }
        }

        return members;
    }

    private parseSimpleValue(structValue: string, parentName: string): StructMember[] {
        const member: StructMember = {
            name: 'value',
            path: 'value',
            value: structValue,
            type: 'simple',
            isStruct: false,
            isUnion: false,
            isArray: false,
            numericValue: this.extractNumericValue(structValue)
        };

        return [member];
    }

    private parseSingleMember(memberStr: string, parentName: string): StructMember | null {
        // Try different member formats

        // Format: "member = value"
        const match = memberStr.match(/^\s*([^=]+)=\s*(.+)$/);
        if (match) {
            const name = match[1].trim();
            const value = match[2].trim();

            return {
                name,
                path: name,
                value,
                type: this.inferType(value),
                isStruct: value.includes('{') && value.includes('}'),
                isUnion: value.includes('<') || (value.includes('union') && !value.includes('{')),
                isArray: value.includes('[') && value.includes(']'),
                numericValue: this.extractNumericValue(value),
                children: this.parseNestedMembers(value, name)
            };
        }

        // Format: just a value (no member name)
        const numericValue = this.extractNumericValue(memberStr);
        if (numericValue !== null) {
            return {
                name: 'value',
                path: 'value',
                value: memberStr,
                type: 'numeric',
                isStruct: false,
                isUnion: false,
                isArray: false,
                numericValue
            };
        }

        return null;
    }

    private parseNestedMembers(value: string, parentPath: string): StructMember[] | undefined {
        if (value.includes('{') && value.includes('}')) {
            const nestedStruct = this.parseStructMembers(value, parentPath);
            return nestedStruct.map((member) => ({
                ...member,
                path: `${parentPath}.${member.path}`
            }));
        }
        return undefined;
    }

    private splitNestedStructures(content: string): string[] {
        const parts: string[] = [];
        let current = '';
        let braceDepth = 0;
        let angleDepth = 0;
        let inQuotes = false;
        let quoteChar = '';

        for (let i = 0; i < content.length; i++) {
            const char = content[i];

            // Handle quotes
            if ((char === '"' || char === '\'') && !inQuotes) {
                inQuotes = true;
                quoteChar = char;
                current += char;
            } else if (char === quoteChar && inQuotes) {
                inQuotes = false;
                current += char;
            } else if (inQuotes) {
                current += char;
            } else {
                // Handle nested structures
                if (char === '{') braceDepth++;
                else if (char === '}') braceDepth--;
                else if (char === '<') angleDepth++;
                else if (char === '>') angleDepth--;

                if (char === ',' && braceDepth === 0 && angleDepth === 0) {
                    parts.push(current.trim());
                    current = '';
                } else {
                    current += char;
                }
            }
        }

        if (current.trim()) {
            parts.push(current.trim());
        }

        return parts.filter((part) => part.length > 0);
    }

    private inferType(value: string): string {
        if (value.includes('{') && value.includes('}')) return 'struct';
        if (value.includes('<') && value.includes('>')) return 'union';
        if (value.includes('[') && value.includes(']')) return 'array';
        if (/^\d+\.?\d*$/.test(value)) return 'number';
        if (/^0[xX][0-9a-fA-F]+$/.test(value)) return 'hex';
        if (/^0[bB][01]+$/.test(value)) return 'binary';
        if (/^'.*'$/.test(value)) return 'char';
        if (/^".*"$/.test(value)) return 'string';
        return 'unknown';
    }

    private extractNumericValue(value: string): number | null {
        if (!value) return null;

        const trimmed = value.trim();

        // Direct number
        const numMatch = trimmed.match(/^-?\d+\.?\d*$/);
        if (numMatch) {
            return parseFloat(numMatch[0]);
        }

        // Hexadecimal
        const hexMatch = trimmed.match(/^0[xX]([0-9a-fA-F]+)$/);
        if (hexMatch) {
            return parseInt(hexMatch[1], 16);
        }

        // Binary
        const binMatch = trimmed.match(/^0[bB]([01]+)$/);
        if (binMatch) {
            return parseInt(binMatch[1], 2);
        }

        // Try to extract from expressions
        const embeddedNum = trimmed.match(/(-?\d+\.?\d*)/);
        if (embeddedNum) {
            return parseFloat(embeddedNum[1]);
        }

        return null;
    }

    private calculateTotalValue(members: StructMember[]): number {
        let total = 0;

        const addToTotal = (memberList: StructMember[]) => {
            for (const member of memberList) {
                if (member.numericValue !== undefined) {
                    total += member.numericValue;
                }
                if (member.children) {
                    addToTotal(member.children);
                }
            }
        };

        addToTotal(members);
        return total;
    }

    private calculateHash(members: StructMember[]): string {
        const memberStrings = members.map((member) =>
            `${member.name}:${member.value}:${member.type}`
        ).sort().join('|');

        let hash = 0;
        for (let i = 0; i < memberStrings.length; i++) {
            const char = memberStrings.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(16);
    }

    private findMemberByPath(members: StructMember[], path: string): StructMember | null {
        for (const member of members) {
            if (member.path === path) {
                return member;
            }
            if (member.children) {
                const found = this.findMemberByPath(member.children, path);
                if (found) return found;
            }
        }
        return null;
    }

    private isArrayRepresentation(value: string): boolean {
        // Check for patterns like "[0] = value" or array syntax
        return /\[\d+\]\s*=/.test(value) || (/^\s*\{.*\[\d+\]/.test(value) && /\]\s*=/.test(value));
    }

    private createFallbackStructure(name: string, value: string): ParsedStructure {
        const hash = this.calculateSimpleHash(value);

        return {
            name,
            type: 'unknown',
            members: [{
                name: 'value',
                path: 'value',
                value,
                type: 'fallback',
                isStruct: false,
                isUnion: false,
                isArray: false,
                numericValue: this.extractNumericValue(value)
            }],
            totalValue: this.extractNumericValue(value) || 0,
            hash
        };
    }

    private calculateSimpleHash(value: string): string {
        let hash = 0;
        for (let i = 0; i < value.length; i++) {
            const char = value.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(16);
    }
}
