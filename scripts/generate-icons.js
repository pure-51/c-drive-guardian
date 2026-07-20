const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const ASSETS = path.join(__dirname, "..", "assets");
const SVG = path.join(ASSETS, "icon.svg");

const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  // Generate PNGs at all sizes
  const pngBuffers = {};
  for (const size of SIZES) {
    pngBuffers[size] = await sharp(SVG)
      .resize(size, size)
      .png()
      .toBuffer();

    // Save individual PNG (for tray use 32x32)
    if (size === 32) {
      fs.writeFileSync(path.join(ASSETS, "tray-icon.png"), pngBuffers[size]);
      console.log(`  ✓ tray-icon.png (32x32)`);
    }
  }

  // Create .ico file
  // ICO format: header (6 bytes) + directory entries (16 bytes each) + image data
  const numImages = SIZES.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);     // Reserved (0)
  header.writeUInt16LE(1, 2);     // Type: 1 = ICO
  header.writeUInt16LE(numImages, 4); // Count

  // Calculate offsets: header + all directory entries
  let offset = 6 + numImages * 16;
  const dirEntries = [];
  const imageData = [];

  for (const size of SIZES) {
    const png = pngBuffers[size];
    const w = size >= 256 ? 0 : size;  // 0 = 256 in ICO
    const h = size >= 256 ? 0 : size;

    const entry = Buffer.alloc(16);
    entry.writeUInt8(w, 0);       // Width
    entry.writeUInt8(h, 1);       // Height
    entry.writeUInt8(0, 2);       // Color palette (0 = no palette)
    entry.writeUInt8(0, 3);       // Reserved
    entry.writeUInt16LE(1, 4);    // Color planes
    entry.writeUInt16LE(32, 6);   // Bits per pixel
    entry.writeUInt32LE(png.length, 8);  // Image data size
    entry.writeUInt32LE(offset, 12);     // Offset in file

    dirEntries.push(entry);
    imageData.push(png);
    offset += png.length;
  }

  const ico = Buffer.concat([header, ...dirEntries, ...imageData]);
  fs.writeFileSync(path.join(ASSETS, "icon.ico"), ico);
  console.log(`  ✓ icon.ico (${SIZES.length} sizes embedded)`);

  console.log("\nDone! Icons generated successfully.");
}

main().catch(err => {
  console.error("Icon generation failed:", err);
  process.exit(1);
});
