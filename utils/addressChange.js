const i2c = require('i2c-bus');
if (process.argv.length !== 4) {
    process.exit(1);
}
// Constants
const VL53L0X_I2C_ADDRESS = parseInt(process.argv[2]);  // Default I2C address of VL53L0X
const VL53L0X_I2C_SLAVE_DEVICE_ADDRESS = 0x8A;  // I2C address change register

// Create an I2C instance
const i2c1 = i2c.openSync(1);  // Open the I2C bus (bus number 1)

// Read the current I2C address
const currentAddress = i2c1.readByteSync(VL53L0X_I2C_ADDRESS, VL53L0X_I2C_SLAVE_DEVICE_ADDRESS);
console.log(VL53L0X_I2C_ADDRESS === currentAddress)

// Calculate and set the new I2C address
const newAddress = parseInt(process.argv[3]);  // New desired I2C address
i2c1.writeByteSync(VL53L0X_I2C_ADDRESS, VL53L0X_I2C_SLAVE_DEVICE_ADDRESS, newAddress);

// Close the I2C bus
i2c1.closeSync();

// Print the results
console.log(`Current Address: 0x${currentAddress.toString(16)}`);
console.log(`New Address: 0x${newAddress.toString(16)}`);
