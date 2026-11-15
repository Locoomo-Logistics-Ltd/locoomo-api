import {
  CSV_TEMPLATE,
  CsvFormatError,
  csvToShipments,
  parseCsv,
} from './shipment-import';

describe('parseCsv', () => {
  it('handles quotes, embedded commas and newlines, CRLF and a BOM', () => {
    const bom = String.fromCharCode(0xfeff);
    const text = `${bom}a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\n1,2,3\n`;
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
      ['1', '2', '3'],
    ]);
  });

  it('keeps empty fields and a last line without a newline', () => {
    expect(parseCsv('a,,c\n,,')).toEqual([['a', '', 'c']]);
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('rejects an unclosed quote', () => {
    expect(() => parseCsv('a,"b\n1,2')).toThrow(CsvFormatError);
  });
});

describe('csvToShipments', () => {
  it('turns the template into a shipment body', () => {
    const { items, lines } = csvToShipments(parseCsv(CSV_TEMPLATE));
    expect(lines).toEqual([2]);
    expect(items[0]).toEqual({
      reference: 'ORD-1001-1',
      destinationNodeId: '8b0e2f4a-0000-4000-8000-000000000000',
      origin: { type: 'node', nodeId: '7a1d9e42-0000-4000-8000-000000000000' },
      receiver: {
        name: 'Chioma Okafor',
        phone: '08031234567',
        email: 'chioma@example.com',
      },
      parcel: {
        description: 'Wireless earbuds',
        size: 'small',
        weightKg: 0.4,
        lengthCm: 15,
        widthCm: 10,
        heightCm: 6,
        handling: ['fragile'],
        declaredValueKobo: 2_500_000,
      },
      notifyReceiver: 'locoomo',
      metadata: { order_id: '1001' },
    });
  });

  it('accepts columns in any order and case, and leaves out blanks', () => {
    const { items } = csvToShipments(
      parseCsv(
        'SIZE,Reference,receiver_phone,receiver_name,description,destination_node_id,handling\n' +
          'Medium,R-1,0803,Ada,Shoes,n1,fragile;keep_upright\n',
      ),
    );
    expect(items[0]).toEqual({
      reference: 'R-1',
      destinationNodeId: 'n1',
      receiver: { name: 'Ada', phone: '0803' },
      parcel: {
        description: 'Shoes',
        size: 'medium',
        handling: ['fragile', 'keep_upright'],
      },
    });
  });

  it('passes bad numbers through for validation to report', () => {
    const { items } = csvToShipments(
      parseCsv(
        'reference,destination_node_id,receiver_name,receiver_phone,description,size,weight_kg\n' +
          'R-1,n1,Ada,0803,Box,small,heavy\n',
      ),
    );
    expect((items[0].parcel as { weightKg: unknown }).weightKg).toBe('heavy');
  });

  it('rejects unknown and missing columns', () => {
    expect(() => csvToShipments(parseCsv('reference,colour\nR,red'))).toThrow(
      /Unknown columns: colour/,
    );
    expect(() => csvToShipments(parseCsv('reference\nR'))).toThrow(
      /Missing columns: destination_node_id/,
    );
    expect(() => csvToShipments([])).toThrow(/empty/);
  });
});
