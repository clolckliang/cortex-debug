// Test what customRequest returns
const result = { variables: [{ name: 'x', value: '10', variablesReference: 0 }] };
console.log('result:', result);
console.log('result.variables:', result.variables);
console.log('result?.variables?.length:', result?.variables?.length);
