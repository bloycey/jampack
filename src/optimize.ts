import { globby } from 'globby';
import * as path from 'path';
import * as fs from 'fs/promises';
import cheerio from 'cheerio';
import { isNumeric } from './utils.js';
import config from './config.js';
import { Image, compressImage } from './compressors/images.js';
import svgToMiniDataURI from 'mini-svg-data-uri';
import $state from './state.js';
import kleur from 'kleur';
import ora from 'ora';
import { isLocal, Resource, translateSrc } from './utils/resource.js';

async function analyse(file: string): Promise<void> {
  console.log('▶ ' + file);

  const html = (await fs.readFile(path.join($state.dir, file))).toString();
  const $ = cheerio.load(html, {
    withStartIndices: true,
    decodeEntities: false,
  });

  const theFold = getTheFold($);

  const imgs = $('img');
  const imgsArray: cheerio.Element[] = [];
  imgs.each(async (index, imgElement) => {
    imgsArray.push(imgElement);
  });

  // Process images sequentially
  const spinnerImg = ora({ prefixText: ' ' }).start();
  for (let i = 0; i < imgsArray.length; i++) {
    const imgElement = imgsArray[i];
    spinnerImg.text = kleur.dim(
      `<img> [${i + 1}/${imgsArray.length}] ${$(imgElement).attr('src')} `
    );

    const isAboveTheFold = imgElement.startIndex! < theFold;
    await processImage(file, $, imgElement, isAboveTheFold);
  }

  // Reset spinner
  spinnerImg.text = kleur.dim(
    `<img> [${imgsArray.length}/${imgsArray.length}]`
  );

  // Notify issues
  const issues = $state.issues.get(file);
  if (issues) {
    spinnerImg.fail();
    console.log(
      kleur.red(`  ${issues.length} issue${issues.length > 1 ? 's' : ''}`)
    );
  } else {
    spinnerImg.succeed();
  }

  // Remove the fold
  if (theFold) {
    $('the-fold').remove();
  }

  // Add CSS to head
  const CSS = `<style>:where(img){height:auto;}</style>`;
  const heads = $('head');
  if (heads.length > 0) {
    heads.prepend(CSS);
  } else {
    $('html')?.prepend(`<head>${CSS}</head>`);
  }

  if (!$state.args.nowrite) {
    await fs.writeFile(path.join($state.dir, file), $.html());
  }
}

function getTheFold($: cheerio.Root): number {
  const theFolds = $('the-fold');
  if (!theFolds[0]) {
    return 0;
  }

  // @ts-ignore
  return theFolds[0].startIndex;
}

async function processImage(
  htmlfile: string,
  $: cheerio.Root,
  imgElement: cheerio.Element,
  isAboveTheFold: boolean
): Promise<void> {
  try {
    const img = $(imgElement);

    /*
     * Attribute 'src'
     */
    const attrib_src = img.attr('src');
    if (!attrib_src) {
      $state.reportIssue(htmlfile, {
        type: 'warn',
        msg: `Missing [src] on img - processing skipped.`,
      });
      return;
    }

    /*
     * Attribute 'alt'
     */
    const attrib_alt = img.attr('alt');
    if (attrib_alt === undefined) {
      $state.reportIssue(htmlfile, {
        type: 'a11y',
        msg: `Missing [alt] on img src="${attrib_src}" - Adding alt="" meanwhile.`,
      });
      img.attr('alt', '');
    }

    if (attrib_src.startsWith('data:')) {
      // Data URI image
      // TODO: try to compress it
      return;
    }

    /*
     * Attribute 'loading'
     */
    const attr_loading = img.attr('loading');
    if (isAboveTheFold) {
      img.removeAttr('loading');
      img.attr('fetchpriority', 'high');
    } else {
      switch (attr_loading) {
        case undefined:
          // Go lazy by default
          img.attr('loading', 'lazy');
          break;
        case 'eager':
          img.removeAttr('loading');
          break;
        case 'lazy':
          // Don't touch it
          break;
        default:
          $state.reportIssue(htmlfile, {
            type: 'invalid',
            msg: `Invalid [loading]="${attr_loading}" on img src="${attrib_src}"`,
          });
      }
    }

    /*
     * Attribute 'decoding'
     */
    img.attr('decoding', 'async');

    if (!isLocal(attrib_src)) {
      // Image not local, don't touch it
      return;
    }

    /*
     * Loading image
     */

    const originalImage = await Resource.loadResource(
      $state.dir,
      htmlfile,
      attrib_src
    );

    // No file -> give up
    if (!originalImage) {
      $state.reportIssue(htmlfile, {
        type: 'erro',
        msg: `Can't find img on disk src="${attrib_src}"`,
      });
      return;
    }

    /*
     * Compress image
     */
    let newImage: Image | undefined;

    const originalImageMeta = await originalImage.getImageMeta();
    const canBeProgressiveJpeg =
      isAboveTheFold && originalImageMeta && !originalImageMeta.hasAlpha;

    if (!$state.optimizedFiles.has(originalImage.filePathAbsolute)) {
      // Let's avoid to optimize same images twice
      $state.optimizedFiles.add(originalImage.filePathAbsolute);

      newImage = await compressImage(await originalImage.getData(), {
        toFormat: canBeProgressiveJpeg ? 'pjpg' : 'webp',
      });

      if (
        newImage?.data &&
        (newImage.data.length < (await originalImage.getLen()) ||
          canBeProgressiveJpeg) // Progressive jpg above the fold should get replaced even if bigger
      ) {
        // Do we need to add an new extension?
        const newExtension = `.${newImage.format}`;
        const additionalExtension =
          path.extname(originalImage.filePathAbsolute) === newExtension
            ? ''
            : newExtension;

        const newFilename =
          originalImage.filePathAbsolute + additionalExtension;

        if (!$state.args.nowrite) {
          fs.writeFile(newFilename, newImage.data);
        }

        // Mark new file as optimized
        $state.compressedFiles.add(newFilename);

        // Report compression result
        $state.reportSummary({
          action:
            newFilename !== originalImage.filePathAbsolute
              ? `${await originalImage.getExt()}->${newImage.format}`
              : path.extname(originalImage.filePathAbsolute),
          originalSize: await originalImage.getLen(),
          compressedSize: newImage.data.length,
        });

        img.attr('src', attrib_src + additionalExtension);
      } else {
        // Report non-compression
        $state.reportSummary({
          action: path.extname(originalImage.filePathAbsolute),
          originalSize: await originalImage.getLen(),
          compressedSize: await originalImage.getLen(),
        });
      }
    }

    /*
     * Embed small images
     *
     * TODO this is only embedding images that have
     * successfully be compressed. Should embed original
     * image if it fits the size.
     */
    let isEmbed = false;
    if (newImage && newImage.data.length <= config.image.embed_size) {
      let datauri = undefined;

      switch (newImage.format) {
        case 'svg':
          datauri = svgToMiniDataURI(newImage.data.toString());
          break;
        case 'webp':
          datauri = `data:image/webp;base64,${newImage.data.toString(
            'base64'
          )}`;
          break;
        case 'jpg':
        case 'png':
          // TODO but not possible in current code
          break;
      }

      if (datauri) {
        isEmbed = true;
        img.attr('src', datauri);
        img.removeAttr('loading');
        img.removeAttr('decoding');

        $state.reportSummary({
          action: `${newImage.format}->embed`,
          originalSize: await originalImage.getLen(),
          compressedSize: newImage.data.length,
        });
      }
    }

    if (isEmbed) {
      // Image is embed, no need for more processing
      return;
    }

    /*
     * Attribute 'width' & 'height'
     */
    const [w, h] = await setImageSize(htmlfile, img, originalImage);

    //
    // Stop here if svg
    //
    if ((await originalImage.getExt()) === 'svg') {
      return;
    }

    /*
     * Attribute 'srcset'
     */
    const attr_srcset = img.attr('srcset');
    const attr_sizes = img.attr('sizes');
    if (attr_srcset || attr_sizes) {
      // If srcset or sizes are set, don't touch it.
      // The compress pass will compress the images
      // of the srcset
      //
      // TODO
      // support if sizes alone is set (no srcset) and generate the appropriate srcset
    } else {
      // Generate image set

      // Avif => Avif
      // png, jpg, ... => WebP
      const targetFormat =
        (await originalImage.getMime()) === 'image/avif' ? 'avif' : 'webp';

      const ext = path.extname(attrib_src);
      const fullbasename = attrib_src.slice(0, -ext.length);
      const imageSrc = (addition: string) =>
        `${fullbasename}${addition}.${
          canBeProgressiveJpeg ? 'jpg' : targetFormat
        }`;

      // Start from original image
      let new_srcset = '';

      // Start reduction
      const step = 300; //px
      const ratio = w / h;
      let valueW = w - step;
      let valueH = Math.trunc(valueW / ratio);
      let previousImageSize = newImage?.data
        ? Math.min(newImage.data.length, await originalImage.getLen())
        : await originalImage.getLen();

      while (valueW > config.image.srcset_min_width) {
        const src = imageSrc(`@${valueW}w`);

        const absoluteFilename = translateSrc(
          $state.dir,
          path.dirname(htmlfile),
          src
        );

        let doAddToSrcSet = true;

        // Don't generate srcset file twice
        if (!$state.compressedFiles.has(absoluteFilename)) {
          const compressedImage = await compressImage(
            await originalImage.getData(),
            {
              resize: { width: valueW, height: valueH },
              toFormat: canBeProgressiveJpeg ? 'pjpg' : targetFormat,
            }
          );

          if (
            !compressedImage?.data ||
            compressedImage.data.length >= previousImageSize
          ) {
            // New image is not compressed or bigger than previous image in srcset
            // Don't add to srcset
            doAddToSrcSet = false;
          } else {
            // Write file
            if (!$state.args.nowrite) {
              fs.writeFile(absoluteFilename, compressedImage.data);
            }

            // Set new previous size to beat
            previousImageSize = compressedImage.data.length;

            // Add file to list avoid recompression
            $state.compressedFiles.add(absoluteFilename);
          }
        }

        if (doAddToSrcSet) {
          new_srcset += `, ${src} ${valueW}w`;
        }

        // reduce size
        valueW -= step;
        valueH = Math.trunc(valueW / ratio);
      }

      if (new_srcset) {
        img.attr('srcset', `${img.attr('src')} ${w}w` + new_srcset);
        img.attr('sizes', '100vw');
      }
    }
  } catch (e) {
    $state.reportIssue(htmlfile, {
      type: 'erro',
      msg:
        (e as Error).message ||
        `Unexpected error while processing image: ${JSON.stringify(e)}`,
    });
  }
}

async function setImageSize(
  htmlfile: string,
  img: cheerio.Cheerio,
  image: Resource
): Promise<number[]> {
  let width = img.attr('width');
  let height = img.attr('height');
  let width_new: number | undefined = undefined;
  let height_new: number | undefined = undefined;

  // Check valid values
  if (width !== undefined) {
    if (!isNumeric(width)) {
      $state.reportIssue(htmlfile, {
        type: 'warn',
        msg: `Invalid width attribute format: "${width}" - overriding for ${image.src}`,
      });
      width = undefined;
    }
  }
  if (height !== undefined) {
    if (!isNumeric(height)) {
      $state.reportIssue(htmlfile, {
        type: 'warn',
        msg: `Invalid height attribute format: "${height}" - overriding for ${image.src}`,
      });
      height = undefined;
    }
  }

  // If we don't have the metadata, we can't do much more
  const meta = await image.getImageMeta();
  if (!meta) {
    throw new Error(
      `Can't get image meta information of "${image.src}" - some optimizations are not possible without this information.`
    );
  }

  if (meta.width === undefined && meta.height === undefined) {
    throw new Error(
      `Can't get image width and height of "${image.src}" - some optimizations are not possible without this information.`
    );
  }

  const originalRatio = meta.width! / meta.height!;

  if (width !== undefined && height !== undefined) {
    // Both are provided
    const w = parseInt(width, 10);
    const h = parseInt(height, 10);

    return [w, h];
  } else if (width !== undefined && height === undefined) {
    // Width is provided
    width_new = parseInt(width, 10);
    height_new = width_new / originalRatio;
  } else if (width === undefined && height !== undefined) {
    // Height is provided
    height_new = parseInt(height, 10);
    width_new = height_new * originalRatio;
  } else {
    // No width or height provided - set both to image size

    if ((await image.getExt()) === 'svg') {
      // svg with no height and width has special sizing by browsers
      // They size it inside 300x150 unless they have width and height
      // attributes

      // Load svg
      const c = cheerio.load(await image.getData(), {});
      const svg = c('svg').first();
      const svg_viewbox = svg.attr('viewbox'); // bug in cheerio here, should be "viewBox"
      const svg_width = svg.attr('width');
      const svg_height = svg.attr('height');

      // Calculate aspect ratio from viewbox
      let svg_aspectratio_from_viewbox: number | undefined = undefined;
      if (svg_viewbox) {
        const box = svg_viewbox.split(' ');
        const w = parseInt(box[2], 10);
        const h = parseInt(box[3], 10);
        svg_aspectratio_from_viewbox = w / h;
      }

      // Set size
      //
      if (
        svg_width &&
        isNumeric(svg_width) &&
        svg_height &&
        isNumeric(svg_height)
      ) {
        // height and width are present
        // use them
        width_new = parseInt(svg_width, 10);
        height_new = parseInt(svg_height, 10);
      } else if (
        svg_width === undefined &&
        svg_height === undefined &&
        svg_aspectratio_from_viewbox
      ) {
        // no height and no width but viewbox is present
        // fit it in default browser box 300x150
        if (svg_aspectratio_from_viewbox >= 2) {
          // fit width
          width_new = 300;
          height_new = width_new / svg_aspectratio_from_viewbox;
        } else {
          // fit height
          height_new = 150;
          width_new = height_new * svg_aspectratio_from_viewbox;
        }
      } else {
        // no width and no height and no viewbox
        // default browser values
        width_new = 300;
        height_new = 150;
      }
    } else {
      width_new = meta.width;
      height_new = meta.height;
    }
  }

  // New sizes
  if (width_new !== undefined && height_new !== undefined) {
    const result_w = Math.round(width_new);
    const result_h = Math.round(height_new);
    img.attr('width', result_w.toFixed(0));
    img.attr('height', result_h.toFixed(0));
    return [result_w, result_h];
  }

  // Something when wrong
  throw new Error(`Unexpected issue when resolving image size "${image.src}"`);
}

export async function optimize(exclude?: string): Promise<void> {
  const glob = ['**/*.{htm,html}'];
  if (exclude) glob.push('!' + exclude);

  const paths = await globby(glob, { cwd: $state.dir });

  // Sequential async
  for (const file of paths) {
    await analyse(file);
  }
}
