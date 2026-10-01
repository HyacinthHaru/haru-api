import { describe, expect, it } from 'vitest'
import { forgeFilesFromMeta, parseForgeLongVersion, parsePromoKey, preferredForgeFile } from '../src/parsers/forge.js'
import { parseLiteLoaderVersions } from '../src/parsers/liteloader.js'
import { neoforgeMcVersion, parseNeoForgeVersion } from '../src/parsers/neoforge.js'
import { parseAdloadx, parseOptiFineDownloads, parseOptiFineFilename } from '../src/parsers/optifine.js'
import { compareVersions } from '../src/parsers/version.js'
import { read } from './fake-upstream.js'

describe('compareVersions', () => {
  it('orders minecraft versions', () => {
    const list = ['1.20.1', '1.7.10', '1.1', '1.20', '1.7.10_pre4', '1.12.2', '1.8.9']
    expect(list.sort(compareVersions)).toEqual(['1.1', '1.7.10_pre4', '1.7.10', '1.8.9', '1.12.2', '1.20', '1.20.1'])
  })

  it('puts pre-releases before releases', () => {
    expect(compareVersions('20.4.80-beta', '20.4.80')).toBeLessThan(0)
    expect(compareVersions('1.12.2-SNAPSHOT', '1.12.2')).toBeLessThan(0)
    expect(compareVersions('I7_pre10', 'I7_pre3')).toBeGreaterThan(0)
  })
})

describe('forge', () => {
  it('parses maven versions', () => {
    expect(parseForgeLongVersion('1.20.1-47.2.0', '1.20.1')).toEqual({
      mcversion: '1.20.1',
      version: '47.2.0',
      lastComponent: 0,
      branch: null,
      legacy: false,
    })
    expect(parseForgeLongVersion('1.7.10-10.13.4.1614-1.7.10', '1.7.10')).toMatchObject({
      version: '10.13.4.1614',
      lastComponent: 1614,
      branch: '1.7.10',
      legacy: true,
    })
    expect(parseForgeLongVersion('1.7.10_pre4-10.12.2.1149-prerelease', '1.7.10_pre4')).toMatchObject({
      mcversion: '1.7.10_pre4',
      version: '10.12.2.1149',
      branch: 'prerelease',
    })
    expect(parseForgeLongVersion('1.1-1.3.2.1')).toMatchObject({ mcversion: '1.1', version: '1.3.2.1', lastComponent: 1 })
    expect(parseForgeLongVersion('garbage')).toBeNull()
  })

  it('maps meta.json classifiers to files', () => {
    const files = forgeFilesFromMeta(JSON.parse(read('forge/meta/1.20.1-47.2.0.json').toString()))
    expect(files).toContainEqual({ format: 'jar', category: 'installer', hash: '1279b07bb259cf51a1c0d02036485565' })
    expect(files).toContainEqual({ format: 'txt', category: 'changelog', hash: '33920c65e80638079c133c9237241f7e' })
    expect(preferredForgeFile(files)).toMatchObject({ category: 'installer', format: 'jar' })

    const old = forgeFilesFromMeta(JSON.parse(read('forge/meta/1.1-1.3.2.1.json').toString()))
    expect(preferredForgeFile(old)).toMatchObject({ category: 'client', format: 'zip' })
  })

  it('parses promotion keys', () => {
    expect(parsePromoKey('1.20.1-recommended')).toMatchObject({ mcversion: '1.20.1', promo: 'recommended', branch: null })
    expect(parsePromoKey('1.7.10-latest-1.7.10')).toMatchObject({ mcversion: '1.7.10', promo: 'latest', branch: '1.7.10' })
  })
})

describe('neoforge', () => {
  it('derives minecraft versions', () => {
    expect(neoforgeMcVersion('20.4.237')).toBe('1.20.4')
    expect(neoforgeMcVersion('20.2.3-beta')).toBe('1.20.2')
    expect(neoforgeMcVersion('21.0.0-beta')).toBe('1.21')
    expect(neoforgeMcVersion('21.1.77')).toBe('1.21.1')
    expect(neoforgeMcVersion('0.25w14craftmine.5-beta')).toBe('25w14craftmine')
    expect(neoforgeMcVersion('26.1.0.0-alpha.1+snapshot-1')).toBe('26.1-snapshot-1')
    expect(neoforgeMcVersion('26.1.1.5')).toBe('26.1.1')
  })

  it('normalizes the 1.20.1 artifact', () => {
    expect(parseNeoForgeVersion('forge', '1.20.1-47.1.100')).toEqual({
      artifact: 'forge',
      rawVersion: '1.20.1-47.1.100',
      version: '47.1.100',
      mcversion: '1.20.1',
    })
  })
})

describe('optifine', () => {
  it('parses the downloads page', () => {
    const rows = parseOptiFineDownloads(read('optifine/downloads.html').toString())
    expect(rows.map((r) => r.filename)).toEqual([
      'preview_OptiFine_1.20.4_HD_U_I7_pre3.jar',
      'OptiFine_1.20.1_HD_U_I6.jar',
      'OptiFine_1.12.2_HD_U_G5.jar',
      'OptiFine_1.8.0_HD_U_I7.jar',
    ])
    expect(rows[1]).toEqual({ filename: 'OptiFine_1.20.1_HD_U_I6.jar', forge: 'Forge 47.2.0', date: '21.11.2023' })
    expect(rows[2]?.forge).toBe('Forge #2847')
  })

  it('splits file names the way BMCLAPI keys them', () => {
    expect(parseOptiFineFilename('OptiFine_1.20.1_HD_U_I6.jar')).toEqual({ mcversion: '1.20.1', type: 'HD_U', patch: 'I6', preview: false })
    expect(parseOptiFineFilename('preview_OptiFine_1.20.4_HD_U_I7_pre3.jar')).toEqual({
      mcversion: '1.20.4',
      type: 'HD_U_I7',
      patch: 'pre3',
      preview: true,
    })
  })

  it('finds the tokenised link on adloadx', () => {
    const html = `<a href='downloadx?f=OptiFine_1.20.1_HD_U_I6.jar&amp;x=abc123' onclick='onDownload()'>OptiFine_1.20.1_HD_U_I6.jar</a>`
    expect(parseAdloadx(html)).toBe('downloadx?f=OptiFine_1.20.1_HD_U_I6.jar&x=abc123')
  })
})

describe('liteloader', () => {
  it('flattens versions.json', () => {
    const rows = parseLiteLoaderVersions(JSON.parse(read('liteloader/versions.json').toString()))
    const v1122 = rows.filter((r) => r.mcversion === '1.12.2')
    expect(v1122).toHaveLength(1)
    expect(v1122[0]).toMatchObject({ version: '1.12.2-SNAPSHOT', type: 'SNAPSHOT', hash: '1420785ecbfed5aff4a586c5c9dd97eb', timestamp: 1511880271 })
    expect(v1122[0]?.build).toMatchObject({ tweakClass: 'com.mumfrey.liteloader.launch.LiteLoaderTweaker', file: 'liteloader-1.12.2-SNAPSHOT.jar' })
    expect(rows.filter((r) => r.mcversion === '1.10.2').map((r) => r.type).sort()).toEqual(['RELEASE', 'SNAPSHOT'])
    expect(rows.filter((r) => r.mcversion === '1.7.10').length).toBeGreaterThan(1)
  })
})
