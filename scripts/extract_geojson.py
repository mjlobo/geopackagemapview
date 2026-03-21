#!/usr/bin/env python3

import argparse
import json

import fiona
from fiona.transform import transform_geom
from pyproj import Transformer


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    parser.add_argument("--layer", required=True)
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--bbox")
    return parser.parse_args()


def parse_bbox(raw_bbox):
    if not raw_bbox:
        return None

    values = [float(value) for value in raw_bbox.split(",")]
    if len(values) != 4:
        raise ValueError("bbox must contain 4 comma-separated numbers")
    return values


def feature_to_geojson(feature, source_crs):
    geometry = feature.get("geometry")
    if geometry:
        geometry = transform_geom(
            source_crs, "EPSG:4326", dict(geometry), antimeridian_cutting=False
        )
        geometry = geometry.__geo_interface__

    return {
        "type": "Feature",
        "id": feature.get("id"),
        "properties": json.loads(json.dumps(dict(feature.get("properties", {})))),
        "geometry": geometry,
    }


def main():
    args = parse_args()
    bbox_wgs84 = parse_bbox(args.bbox)

    with fiona.open(args.file, layer=args.layer) as source:
        source_crs = source.crs_wkt or source.crs
        transformed_bbox = None

        if bbox_wgs84:
            transformer = Transformer.from_crs("EPSG:4326", source_crs, always_xy=True)
            min_x, min_y = transformer.transform(bbox_wgs84[0], bbox_wgs84[1])
            max_x, max_y = transformer.transform(bbox_wgs84[2], bbox_wgs84[3])
            transformed_bbox = (min(min_x, max_x), min(min_y, max_y), max(min_x, max_x), max(min_y, max_y))

        iterator = source.filter(bbox=transformed_bbox) if transformed_bbox else iter(source)

        features = []
        count = 0
        for feature in iterator:
            features.append(feature_to_geojson(feature, source_crs))
            count += 1
            if count >= args.limit:
                break

    payload = {
        "type": "FeatureCollection",
        "features": features,
        "layer": args.layer,
        "count": len(features),
        "limit": args.limit,
    }
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
