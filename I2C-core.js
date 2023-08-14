const {openPromisified} = require('i2c-bus');
const {decodeTimeout} = require('./utils/encode-decode');
const {timeoutMclksToMicroseconds} = require('./utils/calcs');
const {calcCommonBudget} = require('./utils/budget');
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
        await this.writeReg(REG.POWER_MANAGEMENT_GO1_POWER_FORCE, REG.SYSTEM_SEQUENCE_CONFIG, this.address)
        await this.writeReg(0xff, REG.SYSTEM_SEQUENCE_CONFIG, this.address) // select collection 1
        await this.writeReg(REG.SYSRANGE_START, REG.SYSRANGE_START, this.address) // kinda like read-only=false?

        await this.writeReg(0xff, 0x06, this.address)
        const x83 = await this.readReg(0x83, this.address) // return hex(x83)
        await this.writeReg(0x83, x83 | REG.SYSTEM_INTERMEASUREMENT_PERIOD, this.address)
        await this.writeReg(0xff, 0x07, this.address)
        await this.writeReg(REG.SYSTEM_HISTOGRAM_BIN, REG.SYSTEM_SEQUENCE_CONFIG, this.address)
        await this.writeReg(REG.POWER_MANAGEMENT_GO1_POWER_FORCE, REG.SYSTEM_SEQUENCE_CONFIG, this.address)
        await this.writeReg(0x94, 0x6b, this.address)
        await this.writeReg(0x83, REG.SYSRANGE_START, this.address)

        // while ((await this._readReg(0x83)) === REG.SYSRANGE_START) {
        //   console.log('not ready') //I haven't gotten here yet
        // }
        // 0x83 seems to be 0x10 now

        await this.writeReg(0x83, REG.SYSTEM_SEQUENCE_CONFIG, this.address)

        await this.writeReg(REG.SYSTEM_HISTOGRAM_BIN, REG.SYSRANGE_START, this.address)
        await this.writeReg(0xff, 0x06, this.address)
        await this.writeReg(
            0x83,
            (await this.readReg(0x83, this.address)) & ~REG.SYSTEM_INTERMEASUREMENT_PERIOD,
            this.address
        )

        await this.writeReg(0xff, REG.SYSTEM_SEQUENCE_CONFIG, this.address) // select collection 1
        await this.writeReg(REG.SYSRANGE_START, REG.SYSTEM_SEQUENCE_CONFIG, this.address) // kinda like read-only=true?
        await this.writeReg(0xff, REG.SYSRANGE_START, this.address) // always set back to the default collection
        await this.writeReg(REG.POWER_MANAGEMENT_GO1_POWER_FORCE, REG.SYSRANGE_START, this.address)

        const tmp = await this.readReg(0x92, this.address)

        return {
            count: tmp & 0x7f,
            aperture: Boolean((tmp >> 7) & REG.SYSTEM_SEQUENCE_CONFIG),
        }
    }

    async getSequenceStepEnables (pin) {
        const sequenceConfig = await this.readReg(REG.SYSTEM_SEQUENCE_CONFIG, this.address)

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
        const msrcDssTccMclks = (await this.readReg(REG.MSRC_CONFIG_TIMEOUT_MACROP, this.address)) + 1
        const preRangeMclks = decodeTimeout(
            await this.readReg(REG.PRE_RANGE_CONFIG_TIMEOUT_MACROP_HI, this.address, true)
        )
        const finalRangeVcselPeriodPclks = await this.getVcselPulsePeriodInternal(
            REG.FINAL_RANGE_CONFIG_VCSEL_PERIOD,
            pin
        )
        const finalRangeMclks =
            decodeTimeout(await this.readReg(REG.FINAL_RANGE_CONFIG_TIMEOUT_MACROP_HI, this.address, true)) -
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
        return ((await this.readReg(type, this.address)) + 1) << 1
    }
}

module.exports = {I2CCore};