const {BytesWritten, openPromisified, PromisifiedBus} = require('i2c-bus');
const {decodeTimeout} = require('./utils/encode-decode');
const {timeoutMclksToMicroseconds} = require('./utils/calcs');
const {calcCommonBudget} = require('./utils/budget');
const {BinaryValue, Gpio} = require('onoff');
const {REG} = require('./utils/REG');

class I2CCore {
    busModule
    bus
    address
    options = {
        signalRateLimit: 0.1,
        vcselPulsePeriod: {
            pre: 18,
            final: 14,
        },
        measurementTimingBudget: 400000,
        regAddressRead: REG.RESULT_RANGE,
    }

    constructor (address, bus) {
        this.bus = bus;
        this.address = address;
        this.timingBudget = -1;
    }


    addressSetup (address) {
        if (!this.address) {
            this.address = {}
        }

        if (address && typeof address !== 'number' && address.length > 0) {
            for (const pin of address) {
                this.address[pin[0]] = {
                    addr: pin[1],
                    gpio: new Gpio(pin[0], 'out'),
                    timingBudget: -1,
                }

                this.address[pin[0]].gpio.writeSync(0)
            }
        } else if (address && typeof address === 'number') {
            this.address[99] = {
                addr: address,
                timingBudget: -1,
            }
        }
    }


    async scan () {
        const scan = await this.busModule.scan()
        const hex = scan.map((s) => '0x' + s.to(16))

        console.log('SCAN', scan, hex)

        return {scan, hex}
    }


    get config () {
        return {
            bus: this.bus,
            options: this.options,
        }
    }


    async setupProviderModule () {
        if (typeof this.bus !== 'number') {
            throw new Error(`Provider i2c-bus requires that bus be a number`)
        }

        try {
            this.busModule = await openPromisified(this.bus)
        } catch (error) {
            throw new Error(`openPromisified, ${error}`)
        }
    }


    async gpioWrite (gpio, value) {
        return new Promise((resolve, reject) => {
            gpio.write(value, (err) => {
                if (err) reject(err)

                const timeout = setTimeout(() => {
                    clearTimeout(timeout)
                    resolve()
                })
            })
        })
    }


    async writeReg (register, value, addr, isReg16 = false) {
        const data = [register]

        if (isReg16) {
            data.push(...[value >> 8, value & 0xff])
        } else {
            data.push(value)
        }

        const buffer = Buffer.from(data)

        return this.write(buffer, addr)
    }


    async write (data, addr) {
        return await this.busModule.i2cWrite(addr, data.length, data)
    }


    async writeMulti (register, array, addr) {
        return this.write(Buffer.alloc(array.length + 1, register), addr)
    }


    async read (register, addr, length = 1) {
        await this.busModule.i2cWrite(addr, 1, Buffer.alloc(1, register)) // tell it the read index
        return await (await this.busModule.i2cRead(addr, length, Buffer.allocUnsafe(length))).buffer
    }


    async readReg (register, addr, isReg16 = false) {
        if (isReg16) {
            const buffer = await this.read(register, addr, 2)
            return (buffer[0] << 8) | buffer[1]
        }

        return (await this.read(register, addr))[0]
    }


    async readMulti (register, addr, length) {
        return this.read(register, addr, length)
    }


    async getSpadInfo (pin) {
        await this.writeReg(REG.POWER_MANAGEMENT_GO1_POWER_FORCE, REG.SYSTEM_SEQUENCE_CONFIG, this.address[pin].addr)
        await this.writeReg(0xff, REG.SYSTEM_SEQUENCE_CONFIG, this.address[pin].addr) // select collection 1
        await this.writeReg(REG.SYSRANGE_START, REG.SYSRANGE_START, this.address[pin].addr) // kinda like read-only=false?

        await this.writeReg(0xff, 0x06, this.address[pin].addr)
        const x83 = await this.readReg(0x83, this.address[pin].addr) // return hex(x83)
        await this.writeReg(0x83, x83 | REG.SYSTEM_INTERMEASUREMENT_PERIOD, this.address[pin].addr)
        await this.writeReg(0xff, 0x07, this.address[pin].addr)
        await this.writeReg(REG.SYSTEM_HISTOGRAM_BIN, REG.SYSTEM_SEQUENCE_CONFIG, this.address[pin].addr)
        await this.writeReg(REG.POWER_MANAGEMENT_GO1_POWER_FORCE, REG.SYSTEM_SEQUENCE_CONFIG, this.address[pin].addr)
        await this.writeReg(0x94, 0x6b, this.address[pin].addr)
        await this.writeReg(0x83, REG.SYSRANGE_START, this.address[pin].addr)

        // while ((await this._readReg(0x83)) === REG.SYSRANGE_START) {
        //   console.log('not ready') //I haven't gotten here yet
        // }
        // 0x83 seems to be 0x10 now

        await this.writeReg(0x83, REG.SYSTEM_SEQUENCE_CONFIG, this.address[pin].addr)

        await this.writeReg(REG.SYSTEM_HISTOGRAM_BIN, REG.SYSRANGE_START, this.address[pin].addr)
        await this.writeReg(0xff, 0x06, this.address[pin].addr)
        await this.writeReg(
            0x83,
            (await this.readReg(0x83, this.address[pin].addr)) & ~REG.SYSTEM_INTERMEASUREMENT_PERIOD,
            this.address[pin].addr
        )

        await this.writeReg(0xff, REG.SYSTEM_SEQUENCE_CONFIG, this.address[pin].addr) // select collection 1
        await this.writeReg(REG.SYSRANGE_START, REG.SYSTEM_SEQUENCE_CONFIG, this.address[pin].addr) // kinda like read-only=true?
        await this.writeReg(0xff, REG.SYSRANGE_START, this.address[pin].addr) // always set back to the default collection
        await this.writeReg(REG.POWER_MANAGEMENT_GO1_POWER_FORCE, REG.SYSRANGE_START, this.address[pin].addr)

        const tmp = await this.readReg(0x92, this.address[pin].addr)

        return {
            count: tmp & 0x7f,
            aperture: Boolean((tmp >> 7) & REG.SYSTEM_SEQUENCE_CONFIG),
        }
    }

    async getSequenceStepEnables (pin) {
        const sequenceConfig = await this.readReg(REG.SYSTEM_SEQUENCE_CONFIG, this.address[pin].addr)

        return {
            msrc: (sequenceConfig >> 2) & 0x1,
            dss: (sequenceConfig >> 3) & 0x1,
            tcc: (sequenceConfig >> 4) & 0x1,
            preRange: (sequenceConfig >> 6) & 0x1,
            finalRange: (sequenceConfig >> 7) & 0x1,
        }
    }

    async getSequenceStepTimeouts (preRange, pin) {
        const preRangeVcselPeriodPclks = await this.getVcselPulsePeriodInternal(REG.PRE_RANGE_CONFIG_VCSEL_PERIOD, pin)
        const msrcDssTccMclks = (await this.readReg(REG.MSRC_CONFIG_TIMEOUT_MACROP, this.address[pin].addr)) + 1
        const preRangeMclks = decodeTimeout(
            await this.readReg(REG.PRE_RANGE_CONFIG_TIMEOUT_MACROP_HI, this.address[pin].addr, true)
        )
        const finalRangeVcselPeriodPclks = await this.getVcselPulsePeriodInternal(
            REG.FINAL_RANGE_CONFIG_VCSEL_PERIOD,
            pin
        )
        const finalRangeMclks =
            decodeTimeout(await this.readReg(REG.FINAL_RANGE_CONFIG_TIMEOUT_MACROP_HI, this.address[pin].addr, true)) -
            (preRange ? preRangeMclks : 0)

        return {
            preRangeVcselPeriodPclks: preRangeVcselPeriodPclks,
            msrcDssTccMclks: msrcDssTccMclks,
            msrcDssTccUs: timeoutMclksToMicroseconds(msrcDssTccMclks, preRangeVcselPeriodPclks),
            preRangeMclks: preRangeMclks,
            preRangeUs: timeoutMclksToMicroseconds(preRangeMclks, preRangeVcselPeriodPclks),
            finalRangeVcselPeriodPclks: finalRangeVcselPeriodPclks,
            finalRangeMclks: finalRangeMclks,
            finalRangeUs: timeoutMclksToMicroseconds(finalRangeMclks, finalRangeVcselPeriodPclks),
        }
    }


    async getSequenceSteps (pin) {
        const enables = await this.getSequenceStepEnables(pin)
        const timeouts = await this.getSequenceStepTimeouts(enables.preRange, pin)

        return {
            enables,
            timeouts,
        }
    }


    async getBudget (v, pin) {
        const sequence = await this.getSequenceSteps(pin)
        return {
            enables: sequence.enables,
            timeouts: sequence.timeouts,
            value: calcCommonBudget(v, sequence.enables, sequence.timeouts),
        }
    }


    async getVcselPulsePeriodInternal (type, pin) {
        return ((await this.readReg(type, this.address[pin].addr)) + 1) << 1
    }
}

module.exports = {I2CCore};