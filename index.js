/**
 * Copyright 2017-2019 by Esri
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *    http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * 
 * ArcGIS JavaScript API to compute a watershed based on a point tapped on a map.
 * This also demonstrates authentication and proxy services. When _useProxy_ is true,
 * the app expects to have a proxy URL setup to the watershed service. See https://developers.arcgis.com/labs/javascript/access-services-with-oauth-2/
 * challenge section for more details how to create a proxy. When _useProxy_ is false,
 * the app creates a UI to log in an ArcGIS user.
 * To run this it requires a bit of setup:
 *   1. You must run this from a web server (not file:// or codepen)
 *   2. You must have an ArcGIS Developer account (https://developers.arcgis.com/sign-up/ or https://developers.arcgis.com/sign-in/)
 *   3. You must have a Client ID created from an app (create one at https://developers.arcgis.com/dashboard/ or use an existing one)
 *   4. To test the proxy version you need to create a Hydrology proxy at https://developers.arcgis.com/applications/{your-app-id}/services
 *     4.a. Remove the _/submitJob_ URL path component from that URL.
 *     4.b. set _useProxy_ to _true_.
 *   5. To test the non-proxy version:
 *     5.a. set _useProxy_ to false.
 *     5.b. when the page loads, click sign in and sign in with your ArcGIS for Developer's account.
 *   6. In the app authentication definition or/and proxy definition, be sure to whitelist your web server referrer URL (e.g. http://localhost/your-app/index.html or whatever you use.)
 */
require([
    "esri/views/MapView",
    "esri/Map",
    "esri/layers/GraphicsLayer",
    "esri/Graphic",
    "esri/tasks/support/FeatureSet",
    "esri/portal/Portal",
    "esri/identity/OAuthInfo",
    "esri/identity/IdentityManager",
    "esri/tasks/Geoprocessor",
    "esri/widgets/Locate",
    "esri/widgets/Track",
    "dojo/on",
    "dojo/dom"
  ], function(MapView, Map, GraphicsLayer, Graphic, FeatureSet, Portal, OAuthInfo, IdentityManager, Geoprocessor, Locate, Track, on, dom) {
    
    var useProxy = true;
    var portalUrl = "https://www.arcgis.com/sharing";

    // See https://developers.arcgis.com/rest/elevation/api-reference/watershed.htm for more info how to use watershed.
    var hydrologyWatershedUrl = "http://hydro.arcgis.com/arcgis/rest/services/Tools/Hydrology/GPServer/Watershed";

    // Create an app at https://developers.arcgis.com/dashboard, then create a Hydrology Proxy at https://developers.arcgis.com/applications/{your-app-id}/services
    // NOTE: remove _/submitJob_ from the generated proxy URL
    var hydrologyWatershedProxy = "???";
    var oauthInfo = new OAuthInfo({
        appId: "???", //*** Your app Client ID goes here ***//
        popup: false
    });
    var processing = false;
    var watershedGeoprocessor = null;
  
    // Create a map with a basemap that looks nice for watershed display.
    var map = new Map({
        basemap: "topo"
    });

    // Create a mapview with an initial viewpoint. This is only a fallback in case Locate fails or the
    // user denies access.
    var view = new MapView({
        container: "viewDiv",
        map: map,
        center: [-116.5403131, 33.8258166], // Palm Springs
        zoom: 10
    });

    // Create a locate widget to place a UI on the map view to allow the user
    // to set their current location (if they approve the browser accessing it.)
    var locate = new Locate({
        view: view,
        useHeadingEnabled: false,
        goToOverride: function(view, options) {
            options.target.scale = 1500;
            return view.goTo(options.target);
        }
    });
    view.ui.add(locate, "top-left");

    // Show a Track widget on the map UI to track the user's location (if they allow it.)
    var track = new Track({
        view: view,
        graphic: new Graphic({
          symbol: {
            type: "simple-marker",
            size: "9px",
            color: "blue",
            outline: {
              color: "#efefef",
              width: "1.2px"
            }
          }
        }),
        useHeadingEnabled: false,
        goToLocationEnabed: false,
        goToOverride: function(view, options) {
          options.target.scale = null;
          return view.goTo(options);
        }
      });
      view.ui.add(track, "top-left");

    // Point symbol to mark the point on the map user asked to watershed.
    var pointSymbol = {
        type: "simple-marker",
        style: "circle",
        color: [59, 148, 0, 1],
        size: "10px",
        outline: {
            color: [255, 255, 0],
            width: 2
        }
    };

    // Polygon to use for the watershed when we get it from the GP task.
    var polygonSymbol = {
        type: "simple-fill",
        color: [22, 22, 205, 0.5],
        outline: {
            color: [255, 255, 0, 0.5],
            width: 2
        }
    };

    // Create graphics layers to show the point requested and the watershed calculated.
    var focusPointLayer = new GraphicsLayer();
    var watersheds = new GraphicsLayer();
    map.addMany([focusPointLayer, watersheds])
    view.on("click", computeWatershed);

    IdentityManager.registerOAuthInfos([oauthInfo]);    

    if (useProxy) {
        // When using the proxy URL hide the log in UI.
        dom.byId('anonymousPanel').style.display = 'none';
        watershedGeoprocessor = createWatershedGeoprocessorTask(hydrologyWatershedProxy);
    } else {
        // When requesting authentication, show the log in UI.
        // When sign-in is clicked, send users to _portalUrl_ to login (could be ArcGIS Online or your Enterprise portal).
        on(dom.byId("sign-in"), "click", function() {
            IdentityManager.getCredential(portalUrl);
        });
        
        // When sign-out is clicked, log out and reload the page.
        on(dom.byId("sign-out"), "click", function() {
            IdentityManager.destroyCredentials();
            window.location.reload();
        });
        
        // Persist logins when the page is refreshed. If the page is loaded and
        // IdentityManager determines there is a logged in user, create the
        // GP Task for watershed processing. It will be ready for a point of interest.
        IdentityManager.checkSignInStatus(portalUrl).then(
            function() {
                dom.byId('anonymousPanel').style.display = 'none';
                dom.byId('personalizedPanel').style.display = 'block';
                var portal = new Portal();
                portal.load().then(function() {
                    // Once the portal has loaded, the user is logged in, create a GP task.
                    watershedGeoprocessor = createWatershedGeoprocessorTask(hydrologyWatershedUrl);
                });
            }
        );
    }

    // Create a watershed geoprocessor task manger given its URL. We do it
    // this way since it could be the real URL or the proxy.
    function createWatershedGeoprocessorTask(url) {
        var watershedGeoprocessor = new Geoprocessor({
            processSpatialReference: view.spatialReference,
            outSpatialReference: view.spatialReference,
            url: url
        });
        showProgressAnimation(false);
        return watershedGeoprocessor;
    }

    // When the map is clicked compute the watershed from the clicked point.
    // Since computing a watershed takes a bit of time, do not compute if computing.
    function computeWatershed(clickEvent) {
        if (watershedGeoprocessor != null && ! processing) {
            showProgressAnimation(true);
            var focusGraphic = showFocusPointOnMap(clickEvent.mapPoint);
            var inputGraphicContainer = [focusGraphic];
            var featureSet = new FeatureSet();
            featureSet.features = inputGraphicContainer;

            var params = {
                "InputPoints": featureSet,
                "SnapDistance": "5000",
                "SnapDistanceUnits": "Meters",
                "SourceDatabase": "FINEST",
                "Generalize": "True"
            };
            processing = true;
            watershedGeoprocessor.submitJob(params)
                .then(function(gpResults) {
                    var jobID = gpResults.jobId;
                    var jobStatus = gpResults.jobStatus;
                    processing = false;
                    showProgressAnimation(false);
                    // The REST API documents job status as "esriJobSucceeded" but the JS API is returning "job-succeeded" :shrug:
                    if (jobStatus == "esriJobSucceeded" || jobStatus == "job-succeeded") {
                        drawWatershed(jobID);
                        drawSnappedPoint(jobID);
                    } else {
                        // maybe job failed?
                    }
                }, function(error) {
                    console.log(error.toString());
                    processing = false;
                    showProgressAnimation(false);
                });
        }
    }

    // Given the geoprocessor job ID, get the watershed polygon. To do this, query
    // the service with the jobId and you should get results (documented at https://developers.arcgis.com/rest/elevation/api-reference/watershed.htm)
    function drawWatershed(jobID) {
        var geoprocessorResults = watershedGeoprocessor.getResultData(jobID, "WatershedArea")
            .then(function(results) {
                var features = results.value.features;
                if (Array.isArray(features) && features.length > 0) {
                    features.forEach(function(feature) {
                        watersheds.add(new Graphic({
                                geometry: feature.geometry,
                                symbol: polygonSymbol
                            })
                        );
                    });
                }
            });
    }

    // Given the geoprocessor job ID, get the snapped point(s) of the watershed calculation. The 
    // snapped point is based on the watershed calculation and may differ from the requested point.
    // Results is documented at https://developers.arcgis.com/rest/elevation/api-reference/watershed.htm
    function drawSnappedPoint(jobID) {
        var geoprocessorResults = watershedGeoprocessor.getResultData(jobID, "SnappedPoints")
            .then(function(results) {
                if (Array.isArray(results.value.features)) {
                    var lastGraphic = null;
                    focusPointLayer.removeAll();
                    results.value.features.forEach(function(feature) {
                        lastGraphic = new Graphic({
                            geometry: feature.geometry,
                            symbol: pointSymbol
                        });
                        focusPointLayer.add(lastGraphic);
                    });
                    view.goTo(lastGraphic);
                }
            });
    }

    // Display a new focus point on the map and clear any prior point. This is the point
    // the user is asking to compute the watershed flow to.
    function showFocusPointOnMap(point) {
        var graphic = new Graphic(point, pointSymbol);
        focusPointLayer.removeAll();
        focusPointLayer.add(graphic);
        return graphic;
    }

    // Show or hide the indicator when a watershed calculation is in progress, since some of them
    // take considerable time.
    function showProgressAnimation(show) {
        var progressElement = document.getElementById("progress");
        if (show == undefined) {
            show = true;
        }
        if (show) {
            progressElement.innerText = "computing..."
        }
        progressElement.style.display = show ? "block" : "none";
    }
});
