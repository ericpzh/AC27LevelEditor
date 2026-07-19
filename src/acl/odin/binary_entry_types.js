/**
 * OdinSerializer BinaryEntryType enum — faithful port.
 * Source: TeamSirenix/odin-serializer, OdinSerializer/Core/DataReaderWriters/Binary/BinaryEntryType.cs
 * (Apache-2.0). Values are the exact byte tokens found in GATCARC4 .acl payloads.
 */

const BinaryEntryType = {
  Invalid: 0x00,
  NamedStartOfReferenceNode: 0x01,
  UnnamedStartOfReferenceNode: 0x02,
  NamedStartOfStructNode: 0x03,
  UnnamedStartOfStructNode: 0x04,
  EndOfNode: 0x05,
  StartOfArray: 0x06,
  EndOfArray: 0x07,
  PrimitiveArray: 0x08,
  NamedInternalReference: 0x09,
  UnnamedInternalReference: 0x0A,
  NamedExternalReferenceByIndex: 0x0B,
  UnnamedExternalReferenceByIndex: 0x0C,
  NamedExternalReferenceByGuid: 0x0D,
  UnnamedExternalReferenceByGuid: 0x0E,
  NamedSByte: 0x0F,
  UnnamedSByte: 0x10,
  NamedByte: 0x11,
  UnnamedByte: 0x12,
  NamedShort: 0x13,
  UnnamedShort: 0x14,
  NamedUShort: 0x15,
  UnnamedUShort: 0x16,
  NamedInt: 0x17,
  UnnamedInt: 0x18,
  NamedUInt: 0x19,
  UnnamedUInt: 0x1A,
  NamedLong: 0x1B,
  UnnamedLong: 0x1C,
  NamedULong: 0x1D,
  UnnamedULong: 0x1E,
  NamedFloat: 0x1F,
  UnnamedFloat: 0x20,
  NamedDouble: 0x21,
  UnnamedDouble: 0x22,
  NamedDecimal: 0x23,
  UnnamedDecimal: 0x24,
  NamedChar: 0x25,
  UnnamedChar: 0x26,
  NamedString: 0x27,
  UnnamedString: 0x28,
  NamedGuid: 0x29,
  UnnamedGuid: 0x2A,
  NamedBoolean: 0x2B,
  UnnamedBoolean: 0x2C,
  NamedNull: 0x2D,
  UnnamedNull: 0x2E,
  TypeName: 0x2F,
  TypeID: 0x30,
  EndOfStream: 0x31,
  NamedExternalReferenceByString: 0x32,
  UnnamedExternalReferenceByString: 0x33,
};

// Reverse lookup: byte value -> enum name (for error messages / debugging)
const EntryTypeName = {};
for (const [k, v] of Object.entries(BinaryEntryType)) EntryTypeName[v] = k;

module.exports = { BinaryEntryType, EntryTypeName };
