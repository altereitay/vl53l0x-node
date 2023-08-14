Basically I took this library: https://github.com/rip3rs/vl53l0x 
and removed the whole typescript part so it will be easier to work with Node.JS.

My main use for this package is with Raspberry Pi 4.

Changes between this library and rip3rs is:
1. You can use multiple sensors but in a different way.
2. Added util script to change the VL35L0X sensor address

# Install
```javascript
npm install vl53l0x-node 
```

# Use
# Single sensor
```javascript
const VL53L0X = require('vl53l0x-node');
const vl53 = new VL53L0X(0x29);

async function init () {
    await vl53.init();
    setInterval(async () =>{
        let mes = await vl53.getRangeMillimeters();
        console.log(mes);
    }, 1000)
}

init();
```

# Multiple Sensors
For using multiple sensor you will have to do the following steps:
1. Connect one of the sensors to the designated SCL and SDA pins on the Raspberry Pi.
2. Use the addressChange script located in the utils folder in the following way:
```shell
node ./node_modules/vl53l0x-node/utils/addressChange.js 0x29 0x2a
```
3. Repeat steps 1 and 2 while incrementing the 0x2a (I tested up to 0x30 and the docs suggests that it can go up to 0x3F).
4. Run example script


```javascript
const VL53L0X = require('vl53l0x-node');
const vl53_1 = new VL53L0X(0x29);
const vl53_2 = new VL53L0X(0x2a);
const vl53_3 = new VL53L0X(0x2b);

async function init () {
    await vl53_1.init();
    await vl53_2.init();
    await vl53_3.init();
    setInterval(async () =>{
        let mes1 = await vl53_1.getRangeMillimeters();
        let mes2 = await vl53_2.getRangeMillimeters();
        let mes3 = await vl53_3.getRangeMillimeters();
        console.log(mes1, mes2, mes3);
    }, 1000)
}

init();
```
# Known Problems
If you have multiple sensors connected to same i2c bus, one of them may disconnect, when it will reconnect it will get the 
default address (0x29), I overcome it by putting each sensor on a different i2c bus.

Example Code for this problem:
```javascript
const VL53L0X = require('vl53l0x-node');
console.log(VL53L0X)

const vl53_1 = new VL53L0X(0x29, 1);
const vl53_2 = new VL53L0X(0x29, 2);
const vl53_3 = new VL53L0X(0x29, 3);

async function init () {
    await vl53_1.init();
    await vl53_2.init();
    await vl53_3.init();
    setInterval(async () =>{
        let mes1 = await vl53_1.getRangeMillimeters();
        let mes2 = await vl53_2.getRangeMillimeters();
        let mes3 = await vl53_3.getRangeMillimeters();
        console.log(`mes1:${mes1},mes2:${mes2}, mes3:${mes3}`)
    }, 1000)
}

init();

```


You may fork this however you would like and if you want you can also submit and issue and I will try to fix it.