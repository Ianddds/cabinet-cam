// Evaluated against a Part Studio through the Onshape API
// (POST /partstudios/d/{did}/{wvm}/{wvmid}/e/{eid}/featurescript).
//
// For every solid part it finds the largest planar face, builds a coordinate
// system on it (z = outward normal of that face, material at z < 0), and
// returns every planar face parallel to it with its edges sampled into
// polylines. The Node side decides which side is up, which outline to profile
// and which faces are dado/rabbet floors.
//
// Side walls Cabinet build tagged as dado / rabbet / groove walls
// ({ cabinetCut, cut }) come back as "cuts": a segment in the same local xy
// plus the z range, so the app knows which way each dado runs.
//
// All lengths are returned in meters as plain numbers.
function(context is Context, queries is map)
{
    // tie-break for equal faces: a skew direction no cabinet face is square to
    const TIE_DIRECTION = normalize(vector(0.31, 0.57, 0.76));
    const AREA_TIE = 1e-5;
    var result = [];
    for (var part in evaluateQuery(context, qAllModifiableSolidBodies()))
    {
        const planar = evaluateQuery(context, qGeometry(qOwnedByBody(part, EntityType.FACE), GeometryType.PLANE));

        // Largest face. Two faces the same size (a part with only through cuts, or
        // the halves of a part split in Onshape) are decided by which way they face
        // in the model, not by the order Onshape lists them, so parts lying the
        // same way in the model come out the same side up.
        var main = undefined;
        var mainArea = 0 * meter ^ 2;
        var mainScore = -2;
        for (var f in planar)
        {
            const a = evArea(context, { "entities" : f });
            const score = dot(evPlane(context, { "face" : f }).normal, TIE_DIRECTION);
            const bigger = a > mainArea * (1 + AREA_TIE);
            const same = !bigger && a >= mainArea * (1 - AREA_TIE);
            if (bigger || (same && score > mainScore))
            {
                mainArea = a;
                main = f;
                mainScore = score;
            }
        }
        if (main == undefined)
            continue;

        const mainPlane = evPlane(context, { "face" : main });
        const cs = planeToCSys(mainPlane);
        const bounds = evBox3d(context, { "topology" : part, "cSys" : cs, "tight" : true });

        var faces = [];
        var cuts = [];
        for (var f in planar)
        {
            const p = evPlane(context, { "face" : f });
            const d = dot(p.normal, mainPlane.normal);
            if (abs(d) < 1e-6)
            {
                // a side wall: if Cabinet build tagged it as a dado / rabbet / groove
                // wall, return it as a segment in the local xy plane
                var tags = [];
                try silent
                {
                    tags = getAttributes(context, { "entities" : f, "attributePattern" : {} });
                }
                for (var a in tags)
                {
                    if (!(a is map) || a.cabinetCut == undefined)
                        continue;
                    const b = evBox3d(context, { "topology" : f, "cSys" : cs, "tight" : true });
                    const nx = dot(p.normal, cs.xAxis);
                    const xm = (b.minCorner[0] + b.maxCorner[0]) / 2;
                    const ym = (b.minCorner[1] + b.maxCorner[1]) / 2;
                    // wall facing x runs along y, and the other way round
                    const seg = abs(nx) > 0.7 ?
                        [[xm / meter, b.minCorner[1] / meter], [xm / meter, b.maxCorner[1] / meter]] :
                        [[b.minCorner[0] / meter, ym / meter], [b.maxCorner[0] / meter, ym / meter]];
                    cuts = append(cuts, {
                                "cut" : a.cut, "kind" : a.cabinetCut, "seg" : seg,
                                "z0" : b.minCorner[2] / meter, "z1" : b.maxCorner[2] / meter
                            });
                }
                continue;
            }
            if (abs(abs(d) - 1) > 1e-6)
                continue;

            const zLocal = fromWorld(cs, p.origin)[2];
            var edges = [];
            for (var e in evaluateQuery(context, qAdjacent(f, AdjacencyType.EDGE, EntityType.EDGE)))
            {
                var params = [0, 1];
                if (isQueryEmpty(context, qGeometry(e, GeometryType.LINE)))
                {
                    params = [];
                    for (var i = 0; i <= 16; i += 1)
                        params = append(params, i / 16);
                }
                var pts = [];
                for (var ln in evEdgeTangentLines(context, { "edge" : e, "parameters" : params }))
                {
                    const lp = fromWorld(cs, ln.origin);
                    pts = append(pts, [lp[0] / meter, lp[1] / meter]);
                }
                edges = append(edges, pts);
            }

            faces = append(faces, {
                        "z" : zLocal / meter,
                        "dir" : d > 0 ? 1 : -1,
                        "area" : evArea(context, { "entities" : f }) / (meter ^ 2),
                        "edges" : edges
                    });
        }

        var name = "";
        var material = "";
        var attributes = [];
        try silent
        {
            name = getProperty(context, { "entity" : part, "propertyType" : PropertyType.NAME });
        }
        try silent
        {
            const m = getProperty(context, { "entity" : part, "propertyType" : PropertyType.MATERIAL });
            if (m != undefined)
                material = m.name;
        }
        try silent
        {
            attributes = getAttributes(context, { "entities" : part });
        }

        result = append(result, {
                    "id" : part.transientId,
                    "name" : name,
                    "material" : material,
                    "attributes" : attributes,
                    "box" : [bounds.minCorner[0] / meter, bounds.minCorner[1] / meter, bounds.minCorner[2] / meter,
                            bounds.maxCorner[0] / meter, bounds.maxCorner[1] / meter, bounds.maxCorner[2] / meter],
                    "faces" : faces,
                    "cuts" : cuts
                });
    }
    return result;
}
